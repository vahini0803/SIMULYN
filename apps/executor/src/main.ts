import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

/**
 * Runs as an HTTP app only so Kubernetes has something to probe — the actual
 * work arrives over Redis, not over HTTP. Nothing here is exposed publicly.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // A pod being torn down must finish the job it is holding, not drop a
  // student's submission mid-run.
  app.enableShutdownHooks();

  const port = config.get<number>('port') ?? 3002;
  await app.listen(port);

  logger.log(`SIMULYN executor listening on :${port}`);
  logger.log(`Queue: redis at ${config.get<string>('redisUrl')}`);
}

void bootstrap();
