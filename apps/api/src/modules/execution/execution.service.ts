import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseJsonOrNull, type ElectronicsQuestion } from '@simulyn/shared';

import {
  assertValidHarness,
  buildProgram,
  extractTraceEvents,
  generateTracedDriver,
  HarnessError,
  normaliseJavaSource,
  outputsMatch,
  splitDriverOutput,
  traceFidelity,
  type HarnessSpec,
  type LangKey,
  type RunOutcome,
  type TraceResult,
} from '@simulyn/shared/execution';

import { PrismaService } from '../../prisma/prisma.service';
import { ExecutionQueueService } from './execution-queue.service';

export interface TestOutcome {
  index: number;
  isHidden: boolean;
  input: string;
  expected: string;
  actual: string | null;
  /** Anything the student printed themselves — never part of the comparison. */
  stdout: string | null;
  passed: boolean;
  stderr: string | null;
  exitCode: number | null;
  timedOut: boolean;
  executionMs: number;
}

/** Shown in place of a hidden case's error, carrying no student content. */
export const HIDDEN_ERROR_NOTICE = 'Your code raised an error on this hidden case.';

/**
 * Strips every student-controlled channel from a hidden test case.
 *
 * Submissions run against hidden cases too, so anything echoed back is a way to
 * read them: `print(nums)` leaks the input through stdout, an exception message
 * leaks it through stderr (a dynamically named exception class defeats even
 * type-only filtering), and `sys.exit(nums[0])` leaks an integer per case
 * through the exit code. Only the verdict, the timing and whether it timed out
 * survive.
 */
export function maskHiddenOutcome(outcome: TestOutcome): TestOutcome {
  return {
    ...outcome,
    input: 'hidden',
    expected: 'hidden',
    actual: outcome.actual === null ? null : 'hidden',
    stdout: null,
    stderr: outcome.stderr ? HIDDEN_ERROR_NOTICE : null,
    exitCode: null,
  };
}


export interface EvaluationResult {
  ok: boolean;
  allPassed: boolean;
  compileError: string | null;
  results: TestOutcome[];
  passedCount: number;
  totalCount: number;
  totalMs: number;
}

export interface ElectronicsOutcome {
  questionId: string;
  text: string;
  expected: number;
  actual: number | null;
  tolerance: number;
  unit: string | null;
  correct: boolean;
}

export interface ElectronicsResult {
  allCorrect: boolean;
  score: number;
  correctCount: number;
  totalCount: number;
  results: ElectronicsOutcome[];
}

@Injectable()
export class ExecutionService implements OnModuleInit {
  private readonly logger = new Logger(ExecutionService.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ExecutionQueueService,
    config: ConfigService,
  ) {
    // No Executor of its own: every path here goes through the queue service,
    // which owns the in-process pool used for inline mode and for fallback.
    this.timeoutMs = config.get<number>('execution.timeoutMs') ?? 8000;
  }

  onModuleInit(): void {
    const available = this.queue.availability();
    const usable = Object.entries(available)
      .filter(([, ok]) => ok)
      .map(([lang]) => lang);
    const missing = Object.entries(available)
      .filter(([, ok]) => !ok)
      .map(([lang]) => lang);

    this.logger.log(`Execution runtimes available: ${usable.join(', ') || 'none'}`);
    if (missing.length > 0) {
      this.logger.warn(
        `Missing runtimes (submissions in these languages will report a toolchain error): ${missing.join(', ')}`,
      );
    }
  }

  /** Which languages this host can run, plus live engine state. */
  async health() {
    return { ...(await this.queue.health()), timeoutMs: this.timeoutMs };
  }

  // ── raw run ────────────────────────────────────────────────────────

  /**
   * Runs code exactly as written. Java sources are relaxed first (imports
   * hoisted, `public` stripped) so a snippet compiles inside our Main.java.
   */
  async run(lang: LangKey, code: string, stdin = ''): Promise<RunOutcome> {
    let source = code;
    if (lang === 'java') {
      const { imports, body } = normaliseJavaSource(code);
      source = `${imports.join('\n')}\n${body}`;
    }
    // Runs on the executor pool too — untrusted code should not execute in the
    // API process just because it arrived from Run rather than Submit.
    return this.queue.raw({
      kind: 'run',
      language: lang,
      program: source,
      stdin,
      timeoutMs: this.timeoutMs,
    });
  }

  // ── evaluation against a problem's test cases ──────────────────────

  async evaluateProblem(problemId: string, code: string, lang: LangKey): Promise<EvaluationResult> {
    const problem = await this.prisma.problem.findUnique({
      where: { id: problemId },
      include: { testCases: { orderBy: { order: 'asc' } } },
    });
    if (!problem) throw new NotFoundException(`Problem ${problemId} not found`);
    if (problem.type !== 'PROGRAMMING') {
      throw new BadRequestException('This is an electronics problem — use POST /electronics/submit');
    }
    if (problem.testCases.length === 0) {
      throw new BadRequestException('This problem has no test cases yet');
    }

    let spec: HarnessSpec;
    try {
      const parsed = parseJsonOrNull<HarnessSpec>(problem.harness);
      assertValidHarness(parsed);
      spec = parsed;
    } catch (error) {
      throw new BadRequestException(
        error instanceof HarnessError ? error.message : 'This problem has an invalid harness definition',
      );
    }

    // Hand the whole submission to the executor pool (or run it here when no
    // queue is configured). The engine never sees the database.
    const outcome = await this.queue.grade({
      kind: 'grade',
      submissionId: problemId,
      code,
      language: lang,
      harness: spec,
      timeoutMs: this.timeoutMs,
      testCases: problem.testCases.map((testCase) => ({
        id: testCase.id,
        input: testCase.input,
        expected: testCase.expected,
        isHidden: testCase.isHidden,
        order: testCase.order,
      })),
    });

    if (outcome.compileError) {
      return {
        ok: false,
        allPassed: false,
        compileError: outcome.compileError,
        results: [],
        passedCount: 0,
        totalCount: problem.testCases.length,
        totalMs: outcome.totalMs,
      };
    }

    const results: TestOutcome[] = outcome.results.map((row, index) => ({
      index,
      isHidden: row.isHidden,
      input: row.input,
      expected: row.expected,
      actual: row.actual,
      stdout: row.stdout,
      passed: row.passed,
      stderr: row.stderr,
      exitCode: row.exitCode,
      timedOut: row.timedOut,
      executionMs: row.executionMs,
    }));

    return {
      ok: outcome.ok,
      allPassed: outcome.passedCount === results.length && results.length > 0,
      compileError: null,
      results,
      passedCount: outcome.passedCount,
      totalCount: results.length,
      totalMs: outcome.totalMs,
    };
  }

  /** Hides everything about a hidden case except whether it passed. */
  maskHidden(result: EvaluationResult): EvaluationResult {
    return {
      ...result,
      results: result.results.map((r) => (r.isHidden ? maskHiddenOutcome(r) : r)),
    };
  }

  // ── traced run ─────────────────────────────────────────────────────

  /**
   * Runs one test case through a driver that narrates itself, so the
   * visualiser can replay what the student's code actually did.
   *
   * Only a visible test case can be traced — replaying a hidden one would
   * hand over its input a step at a time.
   */
  async runWithTrace(
    problemId: string,
    code: string,
    lang: LangKey,
    testCaseIndex = 0,
  ): Promise<TraceResult> {
    const problem = await this.prisma.problem.findUnique({
      where: { id: problemId },
      include: { testCases: { orderBy: { order: 'asc' } } },
    });
    if (!problem) throw new NotFoundException(`Problem ${problemId} not found`);
    if (problem.type !== 'PROGRAMMING') {
      throw new BadRequestException('Only programming problems can be traced');
    }

    const visible = problem.testCases.filter((testCase) => !testCase.isHidden);
    if (visible.length === 0) {
      throw new BadRequestException('This problem has no visible test case to trace');
    }
    const testCase = visible[Math.min(Math.max(testCaseIndex, 0), visible.length - 1)];

    let spec: HarnessSpec;
    try {
      const parsed = parseJsonOrNull<HarnessSpec>(problem.harness);
      assertValidHarness(parsed);
      spec = parsed;
    } catch (error) {
      throw new BadRequestException(
        error instanceof HarnessError ? error.message : 'This problem has an invalid harness',
      );
    }

    const program = generateTracedDriver(lang, code, spec, testCase.input);
    const prepared = await this.queue.raw({
      kind: 'run',
      language: lang,
      program,
      stdin: '',
      timeoutMs: this.timeoutMs,
    });

    {
      if (prepared.compileError) {
        return {
          ok: false,
          truncated: false,
          events: [],
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          compileError: prepared.compileError,
          executionMs: 0,
          fidelity: traceFidelity(lang),
        };
      }

      const run = prepared;
      const { events, truncated, remainder } = extractTraceEvents(run.stdout);
      const { studentOutput } = splitDriverOutput(remainder);

      return {
        ok: !run.timedOut && run.exitCode === 0,
        truncated,
        events,
        stdout: studentOutput,
        stderr: run.stderr.trim(),
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        compileError: null,
        executionMs: run.executionMs,
        fidelity: traceFidelity(lang),
      };
    }
  }

  // ── electronics ────────────────────────────────────────────────────

  async validateElectronics(
    problemId: string,
    answers: { questionId: string; value: number | string }[],
  ): Promise<ElectronicsResult> {
    const problem = await this.prisma.problem.findUnique({ where: { id: problemId } });
    if (!problem) throw new NotFoundException(`Problem ${problemId} not found`);
    if (problem.type !== 'ELECTRONICS') {
      throw new BadRequestException('This is a programming problem — use POST /execute/submit');
    }

    const questions = parseJsonOrNull<ElectronicsQuestion[]>(problem.questions) ?? [];
    if (questions.length === 0) {
      throw new BadRequestException('This problem has no questions yet');
    }

    const given = new Map(answers.map((a) => [a.questionId, a.value]));

    const results: ElectronicsOutcome[] = questions.map((q) => {
      const raw = given.get(q.id);
      const actual = raw === undefined || raw === null || raw === '' ? null : Number(raw);
      const correct =
        actual !== null && Number.isFinite(actual) && Math.abs(actual - q.answer) <= q.tolerance;

      return {
        questionId: q.id,
        text: q.text,
        expected: q.answer,
        actual: actual !== null && Number.isFinite(actual) ? actual : null,
        tolerance: q.tolerance,
        unit: q.unit ?? null,
        correct,
      };
    });

    const correctCount = results.filter((r) => r.correct).length;
    return {
      allCorrect: correctCount === results.length,
      score: Math.round((correctCount / results.length) * problem.points),
      correctCount,
      totalCount: results.length,
      results,
    };
  }
}
