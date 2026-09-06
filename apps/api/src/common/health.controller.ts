import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from './decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Kubernetes probes and the Docker HEALTHCHECK.
 *
 * Excluded from the global prefix in main.ts, so these stay at a fixed path
 * however the app is mounted, and kept out of Swagger — they are plumbing,
 * not API surface. The previous probe target was `/api/docs-json`, which ties
 * liveness to Swagger being enabled and serialises the whole spec on every
 * check.
 */
@ApiExcludeController()
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: the process is up. Deliberately touches nothing else — a failure
   *  here means "restart me", and a database blip is not that. */
  @Public()
  @Get('healthz')
  live() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /** Readiness: it can actually serve. A pod that cannot reach the database
   *  should leave the Service's endpoint list rather than return errors. */
  @Public()
  @Get('readyz')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'up' };
    } catch (error) {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        database: 'down',
        detail: (error as Error).message,
      });
    }
  }
}
