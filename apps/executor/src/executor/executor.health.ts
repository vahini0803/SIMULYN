import { Controller, Get } from '@nestjs/common';

import { ExecutorProcessor } from './executor.processor';

/**
 * Liveness and readiness for Kubernetes.
 *
 * Readiness reports whether this pod can actually compile and run anything —
 * a pod whose toolchain is missing should not be sent jobs.
 */
@Controller()
export class ExecutorHealthController {
  constructor(private readonly processor: ExecutorProcessor) {}

  @Get('healthz')
  liveness() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  @Get('readyz')
  readiness() {
    const capacity = this.processor.capacity;
    const ready = Object.values(capacity.languages).some(Boolean);
    return { status: ready ? 'ok' : 'no-runtimes', ...capacity };
  }
}
