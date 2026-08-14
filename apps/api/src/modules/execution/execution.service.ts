import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseJsonOrNull, type ElectronicsQuestion } from '@simulyn/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { outputsMatch } from './compare';
import { Executor, normaliseJavaSource, type LangKey, type RunOutcome } from './executor';
import {
  assertValidHarness,
  buildProgram,
  HarnessError,
  RESULT_MARKER,
  type HarnessSpec,
} from './harness';

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

/**
 * Splits the driver's return value from whatever the student printed.
 *
 * Without this a stray `print()` inside an otherwise correct solution would
 * land in stdout ahead of the result and fail every case.
 */
export function splitDriverOutput(raw: string): { actual: string; studentOutput: string } {
  // lastIndexOf: the driver writes its marker last, so a student echoing the
  // same string earlier cannot hijack the parse.
  const at = raw.lastIndexOf(RESULT_MARKER);
  if (at === -1) return { actual: raw.trim(), studentOutput: '' };

  return {
    actual: raw.slice(at + RESULT_MARKER.length).trim(),
    studentOutput: raw.slice(0, at).trim(),
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
  private readonly executor: Executor;
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.executor = new Executor(config.get<number>('execution.maxConcurrency') ?? 20);
    this.timeoutMs = config.get<number>('execution.timeoutMs') ?? 8000;
  }

  onModuleInit(): void {
    const available = this.executor.availability();
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

  /** Which languages this host can run, plus live semaphore state. */
  health() {
    return {
      languages: this.executor.availability(),
      concurrency: this.executor.concurrency,
      timeoutMs: this.timeoutMs,
    };
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
    return this.executor.execute(lang, source, stdin, { timeoutMs: this.timeoutMs });
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

    const program = buildProgram(lang, code, spec);
    const prepared = await this.executor.prepare(lang, program, { timeoutMs: this.timeoutMs });
    const startedAt = Date.now();

    try {
      if (prepared.compileError) {
        return {
          ok: false,
          allPassed: false,
          compileError: prepared.compileError,
          results: [],
          passedCount: 0,
          totalCount: problem.testCases.length,
          totalMs: Date.now() - startedAt,
        };
      }

      const results: TestOutcome[] = [];
      for (const [index, testCase] of problem.testCases.entries()) {
        const run = await prepared.run(testCase.input, { timeoutMs: this.timeoutMs });
        const { actual, studentOutput } = splitDriverOutput(run.stdout);
        const passed =
          !run.timedOut &&
          run.exitCode === 0 &&
          outputsMatch(actual, testCase.expected, spec.normalize);

        results.push({
          index,
          isHidden: testCase.isHidden,
          input: testCase.input,
          expected: testCase.expected,
          actual: actual || null,
          stdout: studentOutput || null,
          passed,
          stderr: run.stderr.trim() || null,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          executionMs: run.executionMs,
        });
      }

      const passedCount = results.filter((r) => r.passed).length;
      return {
        ok: true,
        allPassed: passedCount === results.length,
        compileError: null,
        results,
        passedCount,
        totalCount: results.length,
        totalMs: Date.now() - startedAt,
      };
    } finally {
      await prepared.dispose();
    }
  }

  /** Hides the input/expected of hidden cases before returning them to a student. */
  maskHidden(result: EvaluationResult): EvaluationResult {
    return {
      ...result,
      results: result.results.map((r) =>
        r.isHidden
          ? {
              ...r,
              input: 'hidden',
              expected: 'hidden',
              actual: r.actual === null ? null : 'hidden',
              // Their own prints stay visible — it is their code, and it is
              // often the only clue to why a hidden case failed.
              stdout: r.stdout,
              stderr: r.stderr,
            }
          : r,
      ),
    };
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
