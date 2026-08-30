import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './core/config/env.schema';
import { CoreModule } from './core/core.module';
import { SchedulesModule } from './modules/schedules/schedules.module';
import { QueuesModule } from './queues/queues.module';

/**
 * The worker process's own root module (architecture doc 3.7/3.8) — a
 * separate application context from AppModule, not a full HTTP server.
 * Deliberately lean: SchedulesModule pulls in everything it actually
 * needs (ServersModule, BackupsModule, and THEIR transitive deps like
 * NodesModule/DatabasesModule) on its own, so this file only lists what
 * IT directly requires.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), CoreModule, SchedulesModule, QueuesModule],
})
export class WorkerModule {}
