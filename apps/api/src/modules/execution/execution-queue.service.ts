import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import {
  EXECUTION_QUEUE,
  Executor,
  executeJob,
  executeRawJob,
  type ExecutionJob,
  type ExecutionJobResult,
  type GradeJob,
  type RawRunJob,
  type RawRunResult,
} from '@simulyn/shared/execution';
import { QueueEvents, type Queue } from 'bullmq';

/** How long to grade in-process after a queue failure before trying again. */
const QUEUE_COOLDOWN_MS = 60_000;

/**
 * Decides where a submission is graded.
 *
 * With REDIS_URL set the job goes to the executor pool and this waits for the
 * result; without it the same `executeJob` runs in-process, exactly as the API
 * always did. One function serves both paths, so the fallback cannot drift from
 * the queued one.
 *
 * The request is held open until the job finishes rather than returning 202.
 * That keeps `POST /submissions` returning the graded result, which is what the
 * solver and exam pages render from — moving untrusted code off the API pod is
 * the goal here, and it does not require breaking that contract.
 */
@Injectable()
export class ExecutionQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(ExecutionQueueService.name);
  private readonly localExecutor: Executor;
  private readonly waitMs: number;
  /**
   * Set on a queue failure so we stop stalling every request on a queue that is
   * not answering. It is a cooldown rather than a latch: falling back means
   * untrusted code runs in this process, so that has to be a temporary
   * degradation that heals itself, not a one-way door that a single blip closes
   * for the life of the pod.
   */
  private queueDownUntil = 0;
  /** waitUntilFinished needs its own subscriber connection. */
  private readonly queueEvents?: QueueEvents;

  constructor(
    config: ConfigService,
    @Optional() @InjectQueue(EXECUTION_QUEUE) private readonly queue?: Queue,
  ) {
    this.localExecutor = new Executor(config.get<number>('execution.maxConcurrency') ?? 20, {
      warn: (message) => this.logger.warn(message),
    });
    // A job must be allowed to outlast one test case's timeout.
    this.waitMs = (config.get<number>('execution.timeoutMs') ?? 8000) * 12;

    const redisUrl = config.get<string>('execution.redisUrl');
    if (this.queue && redisUrl) {
      this.queueEvents = new QueueEvents(EXECUTION_QUEUE, { connection: { url: redisUrl } });
      this.queueEvents.on('error', (error: Error) => this.logger.warn(`queue events: ${error.message}`));
    }

    this.logger.log(
      this.queue
        ? 'Grading through the executor queue'
        : 'Grading in-process (REDIS_URL not set)',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queueEvents?.close();
  }

  get mode(): 'queue' | 'inline' {
    return this.queue && this.queueEvents && Date.now() >= this.queueDownUntil ? 'queue' : 'inline';
  }

  /**
   * Records a queue failure and starts the cooldown. The next request after it
   * expires tries the queue again, so a transient Redis problem costs a minute
   * of in-process grading rather than the rest of the pod's life.
   */
  private markQueueDown(context: string, error: unknown): void {
    const wasUp = Date.now() >= this.queueDownUntil;
    this.queueDownUntil = Date.now() + QUEUE_COOLDOWN_MS;

    const message = `${context}: ${(error as Error).message}`;
    if (wasUp) {
      this.logger.error(
        `${message} — grading in-process for the next ${QUEUE_COOLDOWN_MS / 1000}s. ` +
          'Untrusted code is running in the API process while this lasts.',
      );
    } else {
      this.logger.warn(`${message} — still degraded.`);
    }
  }

  /** Which languages this host can run — also the fallback engine's toolchains. */
  availability() {
    return this.localExecutor.availability();
  }

  /**
   * Capacity of whichever engine is actually doing the work.
   *
   * `concurrency` describes the in-process fallback pool, which is what runs
   * jobs in inline mode and if the queue goes down. In queue mode the number
   * that matters is the backlog, so the depth is reported alongside it.
   */
  async health() {
    const base = {
      mode: this.mode,
      languages: this.localExecutor.availability(),
      concurrency: this.localExecutor.concurrency,
    };

    if (this.mode !== 'queue' || !this.queue) return base;

    try {
      const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      return {
        ...base,
        queue: {
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
        },
      };
    } catch (error) {
      // The panel should still render if Redis blinks.
      this.logger.warn(`queue depth unavailable: ${(error as Error).message}`);
      return base;
    }
  }

  /** One prepared program, run once — the Run button and visualiser traces. */
  async raw(job: RawRunJob): Promise<RawRunResult> {
    if (this.mode === 'queue') {
      try {
        return (await this.dispatch(this.queue!, job)) as RawRunResult;
      } catch (error) {
        this.markQueueDown('Queue run failed', error);
      }
    }

    return executeRawJob(this.localExecutor, job);
  }

  async grade(job: GradeJob): Promise<ExecutionJobResult> {
    if (this.mode === 'queue') {
      try {
        return (await this.dispatch(this.queue!, job)) as ExecutionJobResult;
      } catch (error) {
        // Never fail a student's submission because the queue is unwell.
        this.markQueueDown('Queue grading failed', error);
      }
    }

    return executeJob(this.localExecutor, job);
  }

  private async dispatch(queue: Queue, job: ExecutionJob): Promise<unknown> {
    const enqueued = await queue.add(job.kind, job, {
      // A student waiting on the Run button beats a background grade.
      priority: job.kind === 'run' ? 5 : 10,
      attempts: 1,
      // NOT `removeOnComplete: true`. Removing the job the instant it finishes
      // races waitUntilFinished, which then cannot read the result and throws
      // "Missing key for job <id>. isFinished" — the request falls back and
      // runs the code here instead. Keeping completed jobs for a minute closes
      // that window while still bounding what Redis holds.
      removeOnComplete: { age: 60, count: 1000 },
      removeOnFail: { age: 3600, count: 200 },
    });

    return enqueued.waitUntilFinished(this.queueEvents!, this.waitMs);
  }
}
