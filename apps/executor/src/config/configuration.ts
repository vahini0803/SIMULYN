export interface ExecutorConfig {
  nodeEnv: string;
  /**
   * Health/probe port. Deliberately its own variable: the repo-root .env sets
   * PORT for the API, and a shared PORT would put both on 3001.
   */
  port: number;
  redisUrl: string;
  execution: {
    /** Jobs pulled from the queue at once. */
    jobConcurrency: number;
    /** Child processes this pod will run at once, across all jobs. */
    maxConcurrency: number;
    timeoutMs: number;
  };
}

function int(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default (): ExecutorConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: int(process.env.EXECUTOR_PORT, 3002),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  execution: {
    jobConcurrency: int(process.env.EXEC_JOB_CONCURRENCY, 4),
    maxConcurrency: int(process.env.EXEC_MAX_CONCURRENCY, 20),
    timeoutMs: int(process.env.EXEC_TIMEOUT_MS, 8000),
  },
});
