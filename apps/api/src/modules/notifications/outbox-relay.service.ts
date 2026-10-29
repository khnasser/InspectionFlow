import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { APP_CONFIG, AppConfig } from '../../common/config';
import { DbService, TenantTx } from '../../common/db.service';

/** Private, loopback, link-local (cloud metadata) and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(v);
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** Signature header: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body"> (verifiable by the receiver). */
export function signWebhookPayload(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/**
 * Publishes the transactional outbox to each tenant's webhook subscriptions
 * (CRM, ERP, fee systems). At-least-once: every event carries a stable id the
 * receiver uses to ignore repeats; a subscription that already accepted an
 * event is not called again when another one is being retried.
 */
@Injectable()
export class OutboxRelayService {
  private readonly log = new Logger('OutboxRelay');
  private running = false;

  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Refuses URLs that resolve to internal addresses, so a tenant admin cannot reach the platform's network. */
  async assertPublicUrl(url: string): Promise<void> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new BadRequestException('Invalid URL');
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw new BadRequestException('Only http and https URLs');
    if (this.config.webhooks.allowPrivateTargets) return;
    if (u.protocol !== 'https:') throw new BadRequestException('Webhook URLs must use https');
    const addrs = await lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw new BadRequestException('Webhook host does not resolve');
    if (addrs.some((a) => isPrivateAddress(a.address))) throw new BadRequestException('Webhook host resolves to a private address');
  }

  async runOnce(limit = 50): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const jobs = await this.db.system<{ id: string; tenant_id: string }>('SELECT * FROM claim_outbox($1)', [limit]);
      for (const j of jobs) {
        await this.db.withTenant(j.tenant_id, null, (tx) => this.publish(tx, j.id)).catch((e) => this.log.error(e));
      }
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  private async publish(tx: TenantTx, id: string): Promise<void> {
    const ev = await tx.one(
      `SELECT id, aggregate_type, aggregate_id, event_type, payload, attempts, created_at FROM outbox WHERE id = $1`,
      [id],
    );
    const subs = await tx.query(
      `SELECT s.id, s.url, s.secret FROM webhook_subscriptions s
        WHERE s.is_active AND ('*' = ANY(s.event_types) OR $1 = ANY(s.event_types))
          AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.subscription_id = s.id AND d.outbox_id = $2 AND d.status = 'DELIVERED')`,
      [ev.event_type, id],
    );
    const body = JSON.stringify({
      id: ev.id,
      type: ev.event_type,
      occurredAt: new Date(ev.created_at).toISOString(),
      tenantId: tx.tenantId,
      subject: { type: ev.aggregate_type, id: ev.aggregate_id },
      data: ev.payload,
    });
    let failed = 0;
    let lastError = '';
    for (const s of subs) {
      let status: number | null = null;
      let error: string | null = null;
      try {
        await this.assertPublicUrl(s.url);
        const res = await fetch(s.url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(this.config.webhooks.timeoutMs),
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'InspectionFlow-Webhooks/1',
            'X-InspectionFlow-Event': ev.event_type,
            'X-InspectionFlow-Delivery': ev.id,
            'X-InspectionFlow-Signature': signWebhookPayload(s.secret, body),
          },
          body,
        });
        status = res.status;
        if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
      } catch (e) {
        error = String((e as Error).message ?? e).slice(0, 500);
      }
      await tx.query(
        `INSERT INTO webhook_deliveries (tenant_id, subscription_id, outbox_id, status, http_status, error) VALUES ($1,$2,$3,$4,$5,$6)`,
        [tx.tenantId, s.id, id, error ? 'FAILED' : 'DELIVERED', status, error],
      );
      if (error) {
        failed++;
        lastError = error;
      }
    }
    if (!failed) {
      await tx.query(`UPDATE outbox SET status = 'PUBLISHED', published_at = now(), locked_at = NULL, last_error = NULL WHERE id = $1`, [id]);
      return;
    }
    const dead = ev.attempts >= this.config.webhooks.maxAttempts;
    await tx.query(
      `UPDATE outbox SET status = $2, last_error = $3, locked_at = NULL,
              next_attempt_at = now() + make_interval(mins => least(power(2, attempts)::int, 360))
        WHERE id = $1`,
      [id, dead ? 'DEAD' : 'FAILED', lastError],
    );
  }
}
