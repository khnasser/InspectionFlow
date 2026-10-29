import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../common/config';
import { ReportsService } from '../reports/reports.service';
import { NotificationsService } from './notifications.service';
import { OutboxRelayService } from './outbox-relay.service';
import { SchedulerService } from './scheduler.service';

/**
 * Background jobs on one timer, in the worker pods (BACKGROUND_JOBS=on). Each
 * job claims rows with FOR UPDATE SKIP LOCKED, so several workers can run.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Jobs');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reports: ReportsService,
    private readonly notifications: NotificationsService,
    private readonly outbox: OutboxRelayService,
    private readonly scheduler: SchedulerService,
  ) {}

  onModuleInit() {
    if (!this.config.reports.worker) return;
    this.timer = setInterval(() => void this.runAll(), this.config.reports.workerIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Scheduler first (it queues messages), then reports (letters wait for their PDF), then delivery. */
  async runAll(): Promise<{ scheduled: number; reports: number; notifications: number; events: number }> {
    if (this.busy) return { scheduled: 0, reports: 0, notifications: 0, events: 0 };
    this.busy = true;
    const safe = async (name: string, fn: () => Promise<number>) => {
      try {
        return await fn();
      } catch (e) {
        this.log.error(`${name}: ${(e as Error).message}`);
        return 0;
      }
    };
    try {
      return {
        scheduled: await safe('scheduler', () => this.scheduler.runOnce()),
        reports: await safe('reports', () => this.reports.runOnce(20)),
        notifications: await safe('notifications', () => this.notifications.runOnce(100)),
        events: await safe('outbox', () => this.outbox.runOnce(100)),
      };
    } finally {
      this.busy = false;
    }
  }
}
