import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EXECUTION_QUEUE } from '@simulyn/shared/execution';

import { ExecutorHealthController } from './executor.health';
import { ExecutorProcessor } from './executor.processor';

@Module({
  // registerQueue is what actually spins up the BullMQ Worker for this queue.
  // The @Processor decorator on its own only marks the class.
  imports: [BullModule.registerQueue({ name: EXECUTION_QUEUE })],
  controllers: [ExecutorHealthController],
  providers: [ExecutorProcessor],
})
export class ExecutorModule {}
