import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { createQueueRedisConnection } from '../../queues/redis-connection';
import { GatewayService } from './gateway.service';

/**
 * The API process's producer for the `gateway-reconcile` queue — same
 * "thin add-a-job half" shape as `ProvisioningQueueService`. A fixed
 * jobId means a burst of triggers (create, remove, transfer all firing
 * within the same tick) collapses into at most one extra out-of-band
 * run on top of the periodic schedule — reconcile is a full re-render of
 * desired state, never an incremental "handle this one server" job, so
 * there is nothing to gain from queuing more than one.
 */
@Injectable()
export class GatewayQueueService implements OnModuleInit, OnModuleDestroy {
  private connection!: IORedis;
  private queue!: Queue;

  constructor(
    private readonly config: ConfigService,
    private readonly gatewayService: GatewayService,
  ) {}

  onModuleInit(): void {
    this.connection = createQueueRedisConnection(this.config);
    this.queue = new Queue('gateway-reconcile', { connection: this.connection });
    this.gatewayService.setReconcileRequester(() => void this.requestReconcile());
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }

  async requestReconcile(): Promise<void> {
    await this.queue.add('reconcile-now', {}, { jobId: 'gateway-reconcile-now', removeOnComplete: true, removeOnFail: true });
  }
}
