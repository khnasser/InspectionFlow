import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { parse } from '../../common/validation';
import { JobsService } from './jobs.service';
import { OutboxRelayService } from './outbox-relay.service';
import { DEFAULT_TEMPLATES } from './templates';

const webhookSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url().max(2000),
  eventTypes: z.array(z.string().min(1).max(100)).min(1).max(50).default(['*']),
});
const templateSchema = z.object({
  code: z.string().min(1).max(64),
  channel: z.enum(['EMAIL', 'SMS', 'IN_APP']),
  locale: z.enum(['ar-AE', 'en-US']),
  subject: z.string().max(300).optional(),
  body: z.string().min(1).max(5000),
});

/** a***@domain, +97150****67: enough to recognise, not to harvest. */
const mask = (v: string | null) =>
  !v ? null : v.includes('@') ? v.replace(/^(.)[^@]*/, '$1***') : v.replace(/^(\+?\d{5})\d+(\d{2})$/, '$1****$2');

@Controller('v1')
export class NotificationsController {
  constructor(
    private readonly db: DbService,
    private readonly jobs: JobsService,
    private readonly relay: OutboxRelayService,
  ) {}

  /** In-app notifications for the signed-in user. */
  @Get('me/notifications')
  inbox(@CurrentUser() user: AuthUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `SELECT id, template_code, payload, entity_type, entity_id, status, created_at, read_at
           FROM notifications WHERE recipient_type = 'USER' AND recipient_id = $1 AND channel = 'IN_APP'
          ORDER BY created_at DESC LIMIT 100`,
        [user.userId],
      ),
    );
  }

  @Post('me/notifications/:id/read')
  @HttpCode(200)
  async read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const rows = await this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `UPDATE notifications SET status = 'READ', read_at = now()
          WHERE id = $1 AND recipient_type = 'USER' AND recipient_id = $2 AND channel = 'IN_APP' RETURNING id`,
        [id, user.userId],
      ),
    );
    if (!rows.length) throw new NotFoundException();
    return { read: true };
  }

  /** Delivery monitor for administrators (addresses masked). */
  @Get('admin/notifications')
  @Roles('ADMIN')
  async monitor(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    const rows = await this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `SELECT id, channel, template_code, recipient_type, status, attempts, last_error, delivered_to, scheduled_for, sent_at, created_at
           FROM notifications WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 200`,
        [status ?? null],
      ),
    );
    return rows.map((r) => ({ ...r, delivered_to: mask(r.delivered_to) }));
  }

  /** Run reports, notifications and the outbox relay now (they also run on a timer). */
  @Post('admin/jobs/run')
  @Roles('ADMIN')
  run() {
    return this.jobs.runAll();
  }

  @Get('admin/webhooks')
  @Roles('ADMIN')
  listWebhooks(@CurrentUser() user: AuthUser) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(`SELECT id, name, url, event_types, is_active, created_at FROM webhook_subscriptions ORDER BY created_at`),
    );
  }

  /** The signing secret is returned once, at creation. */
  @Post('admin/webhooks')
  @Roles('ADMIN')
  async createWebhook(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const w = parse(webhookSchema, body);
    await this.relay.assertPublicUrl(w.url);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const row = await this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.one(
        `INSERT INTO webhook_subscriptions (tenant_id, name, url, secret, event_types) VALUES ($1,$2,$3,$4,$5)
         RETURNING id, name, url, event_types, is_active`,
        [tx.tenantId, w.name, w.url, secret, w.eventTypes],
      ),
    );
    return { ...row, secret };
  }

  @Delete('admin/webhooks/:id')
  @Roles('ADMIN')
  async deleteWebhook(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const rows = await this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(`UPDATE webhook_subscriptions SET is_active = false WHERE id = $1 RETURNING id`, [id]),
    );
    if (!rows.length) throw new NotFoundException();
    return { deactivated: true };
  }

  @Get('admin/webhooks/:id/deliveries')
  @Roles('ADMIN')
  deliveries(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(
        `SELECT d.outbox_id, o.event_type, d.status, d.http_status, d.error, d.attempted_at
           FROM webhook_deliveries d JOIN outbox o ON o.id = d.outbox_id
          WHERE d.subscription_id = $1 ORDER BY d.attempted_at DESC LIMIT 200`,
        [id],
      ),
    );
  }

  /** Effective templates: the tenant's own, else the built-in default. */
  @Get('admin/notification-templates')
  @Roles('ADMIN')
  async templates(@CurrentUser() user: AuthUser) {
    const own = await this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.query(`SELECT code, channel, locale, subject, body, updated_at FROM notification_templates`),
    );
    const out: any[] = [];
    for (const [code, channels] of Object.entries(DEFAULT_TEMPLATES)) {
      for (const [channel, langs] of Object.entries(channels!)) {
        for (const [lang, t] of Object.entries(langs!)) {
          const locale = lang === 'ar' ? 'ar-AE' : 'en-US';
          const o = own.find((x) => x.code === code && x.channel === channel && x.locale === locale);
          out.push({ code, channel, locale, subject: o?.subject ?? t.subject ?? null, body: o?.body ?? t.body, customised: !!o });
        }
      }
    }
    return out;
  }

  @Put('admin/notification-templates')
  @Roles('ADMIN')
  async saveTemplate(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const t = parse(templateSchema, body);
    return this.db.withTenant(user.tenantId, user.userId, (tx) =>
      tx.one(
        `INSERT INTO notification_templates (tenant_id, code, channel, locale, subject, body) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, code, channel, locale) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, updated_at = now()
         RETURNING code, channel, locale, subject, body`,
        [tx.tenantId, t.code, t.channel, t.locale, t.subject ?? null, t.body],
      ),
    );
  }
}
