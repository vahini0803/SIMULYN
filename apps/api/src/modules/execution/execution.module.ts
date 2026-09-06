import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EXECUTION_QUEUE } from '@simulyn/shared/execution';

import { ElectronicsController, ExecutionController } from './execution.controller';
import { ExecutionQueueService } from './execution-queue.service';
import { ExecutionService } from './execution.service';

/**
 * The queue is registered only when REDIS_URL is set. Without it the API grades
 * in-process, which is what local development and a single-box install do —
 * registering BullMQ regardless would sit there retrying a connection that is
 * never going to exist.
 */
const queueImports = process.env.REDIS_URL
  ? [
      BullModule.forRootAsync({
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          connection: { url: config.get<string>('execution.redisUrl') },
        }),
      }),
      BullModule.registerQueue({ name: EXECUTION_QUEUE }),
    ]
  : [];

@Module({
  imports: [...queueImports],
  controllers: [ExecutionController, ElectronicsController],
  providers: [ExecutionService, ExecutionQueueService],
  exports: [ExecutionService, ExecutionQueueService],
})
export class ExecutionModule {}
