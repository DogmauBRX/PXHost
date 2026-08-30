import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';

/**
 * The background worker's entrypoint (architecture doc 3.7: "Workers run
 * as a separate process ... from the API so a slow backup job never
 * touches request latency"). `createApplicationContext` — no HTTP
 * listener, no Fastify adapter — just the DI container, which is all
 * `ScheduleTickProcessor`/`ScheduleDispatchProcessor` need: they start
 * consuming their BullMQ queues from `onModuleInit`. The open Redis
 * connections keep the process alive on their own; no busy-wait needed.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(WorkerModule);
  logger.log('pxhost worker started — schedule-tick + schedule-dispatch processors running');

  const shutdown = async (signal: string) => {
    logger.log(`${signal} received, shutting down worker...`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap();
