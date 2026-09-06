import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'node:path';

import configuration from './config/configuration';
import { ExecutorModule } from './executor/executor.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env', join(__dirname, '..', '.env'), join(__dirname, '..', '..', '..', '.env')],
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.get<string>('redisUrl') },
        defaultJobOptions: {
          // Keep a short tail for debugging; the API owns the durable record.
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      }),
    }),
    ExecutorModule,
  ],
})
export class AppModule {}
