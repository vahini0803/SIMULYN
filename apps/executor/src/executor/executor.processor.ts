import { Logger, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import {
  EXECUTION_QUEUE,
  Executor,
  executeJob,
  executeRawJob,
  type ExecutionJob,
  type ExecutionJobResult,
  type RawRunResult,
} from '@simulyn/shared/execution';
import type { Job } from 'bullmq';

/**
 * The worker.
 *
 * Pulls grading jobs off Redis and runs them with the same engine the API used
 * to run in-process. It never touches the database: everything it needs arrives
 * in the job payload, and the result goes back through BullMQ for the API to
 * persist. That is what lets these pods be locked down to Redis-only egress.
 */
// Jobs pulled at once per pod. Read at import time, so it is a pod-level
// setting rather than something a running worker can be talked into changing.
@Processor(EXECUTION_QUEUE, {
  concurrency: parseInt(process.env.EXEC_JOB_CONCURRENCY ?? '4', 10),
})
export class ExecutorProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(ExecutorProcessor.name);
  private readonly executor: Executor;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    super();
    // Executor owns its own semaphore — do not wrap run() in a second one.
    this.executor = new Executor(config.get<number>('execution.maxConcurrency') ?? 20, {
      warn: (message) => this.logger.warn(message),
    });
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

    this.logger.log(`Runtimes available: ${usable.join(', ') || 'none'}`);
    if (missing.length > 0) {
      this.logger.warn(`Missing runtimes: ${missing.join(', ')}`);
    }
  }

  /** Live capacity, surfaced on the health endpoint for K8s and the admin panel. */
  get capacity() {
    return {
      languages: this.executor.availability(),
      concurrency: this.executor.concurrency,
      timeoutMs: this.timeoutMs,
    };
  }

  async process(job: Job<ExecutionJob>): Promise<ExecutionJobResult | RawRunResult> {
    const payload = job.data;
    const started = Date.now();

    // A bare run (the Run button, or a visualiser trace) arrives already
    // harnessed — compile it, run it once, hand back the raw output.
    if (payload.kind === 'run') {
      const raw = await executeRawJob(this.executor, {
        ...payload,
        timeoutMs: payload.timeoutMs || this.timeoutMs,
      });
      this.logger.log(
        `run (${payload.language}): exit ${raw.exitCode} in ${Date.now() - started}ms` +
          (raw.compileError ? ' (compile error)' : ''),
      );
      return raw;
    }

    const result = await executeJob(
      this.executor,
      // The queue is the contract, but never trust a stale producer's timeout.
      { ...payload, timeoutMs: payload.timeoutMs || this.timeoutMs },
      (done, total) => {
        void job.updateProgress(Math.round((done / total) * 100));
      },
    );

    this.logger.log(
      `submission ${payload.submissionId}: ${result.passedCount}/${result.totalCount} in ${Date.now() - started}ms` +
        (result.compileError ? ' (compile error)' : ''),
    );

    return result;
  }
}
