import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from './redis-connection';
import { GatewayService } from '../modules/gateway/gateway.service';

const RUN_EVERY_MS = 30_000;

/**
 * Public-exposure plan §12 — the reconciliation loop that makes the
 * gateway feature not depend on any single event succeeding. Two things
 * feed the SAME worker: the periodic scheduler (`upsertJobScheduler`,
 * name `run`, every 30s — short enough that a customer notices "server
 * created" become "server reachable" almost immediately, long enough
 * that an idle deployment with no gateway configured does almost no
 * work) and on-demand jobs from `GatewayQueueService.requestReconcile`
 * (name `reconcile-now`, fixed jobId, added right after a create/
 * remove/transfer). Both call the exact same `GatewayService
 * .reconcileOnce()` — there is no separate "handle this one server"
 * code path, matching the driver contract's "full desired state every
 * time" idempotency.
 */
@Injectable()
export class GatewayReconcileProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayReconcileProcessor.name);
  private connection!: IORedis;
  private queue!: Queue;
  private worker!: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly gatewayService: GatewayService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.connection = createQueueRedisConnection(this.config);
    this.queue = new Queue('gateway-reconcile', { connection: this.connection });
    await this.queue.upsertJobScheduler('gateway-reconcile', { every: RUN_EVERY_MS }, { name: 'run' });

    this.worker = new Worker('gateway-reconcile', () => this.gatewayService.reconcileOnce(), { connection: this.connection });
    this.worker.on('failed', (job, err) => {
      this.logger.error(`gateway-reconcile run failed: ${err.message}`);
    });
    this.logger.log('gateway-reconcile worker started (every 30s)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
