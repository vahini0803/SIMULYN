import { outputsMatch } from './compare';
import type { Executor } from './executor';
import type { LangKey } from './executor';
import { buildProgram, type HarnessSpec } from './harness';
import { splitDriverOutput } from './output';

/** BullMQ queue name. Shared so the producer and worker cannot disagree. */
export const EXECUTION_QUEUE = 'code-execution';

/** Everything the worker needs to grade; it never touches the database. */
export interface GradeJob {
  kind: 'grade';
  submissionId: string;
  code: string;
  language: LangKey;
  harness: HarnessSpec;
  timeoutMs: number;
  testCases: {
    id: string;
    input: string;
    expected: string;
    isHidden: boolean;
    order: number;
  }[];
}

/**
 * A single run of an already-built program.
 *
 * Backs both the Run button and the visualiser trace: the producer has already
 * done the harnessing, so the worker just compiles and runs. Keeping the worker
 * this dumb is what lets it be locked down to Redis-only egress.
 */
export interface RawRunJob {
  kind: 'run';
  language: LangKey;
  /** Already normalised and harnessed by the producer. */
  program: string;
  stdin: string;
  timeoutMs: number;
}

export type ExecutionJob = GradeJob | RawRunJob;

export interface RawRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  compileError: string | null;
  executionMs: number;
}

export interface ExecutionCaseResult {
  testCaseId: string;
  /** Kept so the API can rebuild ordering without another query. */
  order: number;
  isHidden: boolean;
  input: string;
  expected: string;
  actual: string | null;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  timedOut: boolean;
  executionMs: number;
  passed: boolean;
}

export interface ExecutionJobResult {
  submissionId: string;
  ok: boolean;
  compileError: string | null;
  results: ExecutionCaseResult[];
  passedCount: number;
  totalCount: number;
  totalMs: number;
}

/**
 * Runs one submission against its test cases.
 *
 * This is the single implementation of "grade this code": the executor
 * microservice calls it from its BullMQ processor, and the API calls it
 * directly when the queue is unavailable. Keeping one function means the
 * fallback path can never drift from the queued path.
 *
 * Note it returns raw stdout, stderr and exit codes for *every* case, hidden
 * ones included. Masking is the API's job — the worker must not be what decides
 * what a student is allowed to see.
 */
export async function executeJob(
  executor: Executor,
  job: GradeJob,
  onProgress?: (done: number, total: number) => void,
): Promise<ExecutionJobResult> {
  const startedAt = Date.now();
  const cases = [...job.testCases].sort((a, b) => a.order - b.order);

  // No test input baked in: the driver reads stdin, so one compile serves
  // every case.
  const program = buildProgram(job.language, job.code, job.harness);
  const prepared = await executor.prepare(job.language, program, { timeoutMs: job.timeoutMs });

  try {
    // prepare() reports a compile error rather than throwing.
    if (prepared.compileError) {
      return {
        submissionId: job.submissionId,
        ok: false,
        compileError: prepared.compileError,
        results: [],
        passedCount: 0,
        totalCount: cases.length,
        totalMs: Date.now() - startedAt,
      };
    }

    const results: ExecutionCaseResult[] = [];

    for (const testCase of cases) {
      const run = await prepared.run(testCase.input, { timeoutMs: job.timeoutMs });
      const { actual, studentOutput } = splitDriverOutput(run.stdout);

      results.push({
        testCaseId: testCase.id,
        order: testCase.order,
        isHidden: testCase.isHidden,
        input: testCase.input,
        expected: testCase.expected,
        actual: actual || null,
        stdout: studentOutput || null,
        stderr: run.stderr.trim() || null,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        executionMs: run.executionMs,
        passed:
          !run.timedOut &&
          run.exitCode === 0 &&
          outputsMatch(actual, testCase.expected, job.harness.normalize),
      });

      onProgress?.(results.length, cases.length);
    }

    const passedCount = results.filter((r) => r.passed).length;
    return {
      submissionId: job.submissionId,
      ok: true,
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

/** Compiles and runs a prepared program once. */
export async function executeRawJob(
  executor: Executor,
  job: RawRunJob,
): Promise<RawRunResult> {
  const outcome = await executor.execute(job.language, job.program, job.stdin, {
    timeoutMs: job.timeoutMs,
    // A traced run narrates itself and produces far more output than a plain one.
    maxOutputBytes: 4 * 1024 * 1024,
  });

  return {
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    compileError: outcome.compileError,
    executionMs: outcome.executionMs,
  };
}
