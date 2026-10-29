import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../common/config';
import { DbService, TenantTx } from '../../common/db.service';
import { payLinkUrl } from '../../common/pay-link';
import { STORAGE, StoragePort } from '../../common/storage';
import { EMAIL_SENDER, EmailSender, SMS_SENDER, SmsSender } from './channels';
import { Channel, DEFAULT_TEMPLATES, fill, Template, toHtml } from './templates';

const LETTERS = new Set(['INSPECTION_REPORT', 'WARNING_LETTER', 'PENALTY_LETTER']);
/** A letter waits this long for its issued PDF before it goes without the attachment. */
const LETTER_PDF_WAIT_MS = 30 * 60_000;

interface Recipient {
  name: string;
  email: string | null;
  phone: string | null;
  locale: string;
}

/** E.164-ish: digits with an optional leading +; UAE local numbers 05x get +971. */
export function normalisePhone(raw: string | null): string | null {
  if (!raw) return null;
  let p = raw.replace(/[\s()-]/g, '');
  if (/^05\d{8}$/.test(p)) p = `+971${p.slice(1)}`;
  if (/^00\d+$/.test(p)) p = `+${p.slice(2)}`;
  return /^\+?\d{8,15}$/.test(p) ? p : null;
}

/** Minutes since midnight in the tenant's time zone. */
function minutesInZone(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')!.value);
  const m = Number(parts.find((p) => p.type === 'minute')!.value);
  return h * 60 + m;
}
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Milliseconds until quiet hours end, or 0 when sending is allowed now. */
export function quietHoursDelay(now: Date, timeZone: string, window: { start: string; end: string } | null): number {
  if (!window) return 0;
  const cur = minutesInZone(now, timeZone);
  const s = toMinutes(window.start);
  const e = toMinutes(window.end);
  const inside = s <= e ? cur >= s && cur < e : cur >= s || cur < e;
  if (!inside) return 0;
  const wait = (e - cur + 24 * 60) % (24 * 60);
  return wait * 60_000;
}

/**
 * Delivers queued notifications. Rows are written in the same transaction as
 * the business change (payment advice, approval, task); this worker sends them
 * later with retries, so a mail or SMS outage never blocks an inspection.
 *  - SMS respects the tenant's quiet hours (default 22:00–07:00 local time).
 *  - Letters wait up to 30 minutes for the issued PDF and attach it.
 *  - Missing contact details end as SKIPPED, with the reason kept.
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger('Notifications');
  private running = false;

  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}

  async runOnce(limit = 50): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const jobs = await this.db.system<{ id: string; tenant_id: string }>('SELECT * FROM claim_notifications($1)', [limit]);
      for (const j of jobs) await this.deliver(j.id, j.tenant_id);
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  private async deliver(id: string, tenantId: string): Promise<void> {
    try {
      await this.db.withTenant(tenantId, null, (tx) => this.deliverIn(tx, id));
    } catch (err) {
      const message = String((err as Error).message).slice(0, 1000);
      this.log.warn(`Notification ${id} failed: ${message}`);
      await this.db.withTenant(tenantId, null, (tx) =>
        tx.query(
          `UPDATE notifications
              SET status = CASE WHEN attempts >= $2 THEN 'FAILED' ELSE 'QUEUED' END,
                  scheduled_for = now() + make_interval(mins => power(2, attempts)::int),
                  last_error = $3, locked_at = NULL
            WHERE id = $1`,
          [id, this.config.notifications.maxAttempts, message],
        ),
      );
    }
  }

  private async finish(tx: TenantTx, id: string, status: 'SENT' | 'SKIPPED', extra: { to?: string | null; messageId?: string | null; reason?: string; locale?: string }) {
    await tx.query(
      `UPDATE notifications SET status = $2, sent_at = CASE WHEN $2 = 'SENT' THEN now() END, delivered_to = $3,
              provider_message_id = $4, last_error = $5, locale = COALESCE($6, locale), locked_at = NULL
        WHERE id = $1`,
      [id, status, extra.to ?? null, extra.messageId ?? null, extra.reason ?? null, extra.locale ?? null],
    );
  }

  private async reschedule(tx: TenantTx, id: string, delayMs: number, reason: string) {
    // Not a failure: give the attempt back.
    await tx.query(
      `UPDATE notifications SET status = 'QUEUED', attempts = attempts - 1, locked_at = NULL, last_error = $3,
              scheduled_for = now() + make_interval(secs => $2::double precision / 1000)
        WHERE id = $1`,
      [id, delayMs, reason],
    );
  }

  private async deliverIn(tx: TenantTx, id: string): Promise<void> {
    const n = await tx.one(
      `SELECT id, recipient_type, recipient_id, recipient_address, channel, template_code, payload, entity_type, entity_id, created_at
         FROM notifications WHERE id = $1`,
      [id],
    );
    const tenant = await tx.one<{ name: string; name_i18n: Record<string, string> | null; default_locale: string; timezone: string }>(
      `SELECT name, name_i18n, default_locale, timezone FROM tenants WHERE id = $1`,
      [tx.tenantId],
    );
    const channel = n.channel as Channel;
    const r = await this.recipient(tx, n, tenant.default_locale);
    const lang: 'ar' | 'en' = r.locale.startsWith('en') ? 'en' : 'ar';

    if (channel === 'IN_APP') {
      // Stored only; the app reads it from /v1/me/notifications.
      return this.finish(tx, id, 'SENT', { locale: r.locale });
    }
    const to = channel === 'EMAIL' ? r.email : channel === 'SMS' ? normalisePhone(r.phone) : null;
    if (!to) return this.finish(tx, id, 'SKIPPED', { reason: `No ${channel.toLowerCase()} contact for recipient`, locale: r.locale });
    if (channel !== 'EMAIL' && channel !== 'SMS') {
      return this.finish(tx, id, 'SKIPPED', { reason: `${channel} delivery is not enabled yet`, locale: r.locale });
    }

    if (channel === 'SMS') {
      const quiet = await this.setting<{ start: string; end: string } | null>(tx, 'notifications.quietHours', { start: '22:00', end: '07:00' });
      const wait = quietHoursDelay(new Date(), tenant.timezone, quiet);
      if (wait > 0) return this.reschedule(tx, id, wait, 'Deferred: tenant quiet hours');
    }

    const vars = await this.variables(tx, n, r, tenant, lang);
    let attachments: Array<{ filename: string; content: Buffer; contentType: string }> | undefined;
    if (channel === 'EMAIL' && LETTERS.has(n.template_code) && n.entity_type === 'INSPECTION') {
      const report = await tx.maybeOne(
        `SELECT g.report_number, g.verification_code, v.s3_key FROM generated_reports g
           LEFT JOIN document_versions v ON v.document_id = g.document_id AND v.version_no = 1
          WHERE g.subject_type = 'INSPECTION' AND g.subject_id = $1 AND g.status <> 'REVOKED'
          ORDER BY g.reissue_no DESC LIMIT 1`,
        [n.entity_id],
      );
      const waited = Date.now() - new Date(n.created_at).getTime();
      if (report && !report.s3_key && waited < LETTER_PDF_WAIT_MS) {
        return this.reschedule(tx, id, 60_000, 'Waiting for the issued PDF');
      }
      if (report?.s3_key) {
        attachments = [{ filename: `${report.report_number}.pdf`, content: await this.storage.get(report.s3_key), contentType: 'application/pdf' }];
        vars.verifyUrl = `${this.config.reports.verifyBaseUrl.replace(/\/$/, '')}/verify/${report.verification_code}`;
      }
    }

    const tpl = await this.template(tx, n.template_code, channel, lang);
    const body = fill(tpl.body, vars);
    if (channel === 'EMAIL') {
      const subject = fill(tpl.subject ?? n.template_code, vars);
      const sent = await this.email.send({ to, subject, text: body, html: toHtml(body, lang), attachments });
      return this.finish(tx, id, 'SENT', { to, messageId: sent.messageId, locale: r.locale });
    }
    const sent = await this.sms.send({ to, text: body });
    if (!sent) return this.finish(tx, id, 'SKIPPED', { reason: 'SMS is switched off for this deployment', locale: r.locale });
    return this.finish(tx, id, 'SENT', { to, messageId: sent.messageId, locale: r.locale });
  }

  private async recipient(tx: TenantTx, n: any, defaultLocale: string): Promise<Recipient> {
    if (n.recipient_type === 'USER') {
      const u = await tx.maybeOne(`SELECT display_name, email, phone, locale FROM users WHERE id = $1`, [n.recipient_id]);
      return u ? { name: u.display_name, email: u.email, phone: u.phone, locale: u.locale } : { name: '', email: null, phone: null, locale: defaultLocale };
    }
    if (n.recipient_type === 'PARTY') {
      const p = await tx.maybeOne(
        `SELECT COALESCE(company_name, concat_ws(' ', first_name, last_name)) AS name, email, phone FROM parties WHERE id = $1`,
        [n.recipient_id],
      );
      return p ? { name: p.name, email: p.email, phone: p.phone, locale: defaultLocale } : { name: '', email: null, phone: null, locale: defaultLocale };
    }
    if (n.recipient_type === 'TEAM') {
      const t = await tx.maybeOne(`SELECT name_i18n, group_email FROM teams WHERE id = $1`, [n.recipient_id]);
      return { name: t?.name_i18n?.[defaultLocale] ?? '', email: t?.group_email ?? null, phone: null, locale: defaultLocale };
    }
    return { name: '', email: n.recipient_address, phone: n.recipient_address, locale: defaultLocale };
  }

  private async variables(tx: TenantTx, n: any, r: Recipient, tenant: any, lang: 'ar' | 'en'): Promise<Record<string, unknown>> {
    const locale = lang === 'ar' ? 'ar-AE' : 'en-US';
    const money = (v: unknown) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v ?? 0));
    const day = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : '-');
    const vars: Record<string, unknown> = {
      ...(n.payload ?? {}),
      partyName: r.name,
      issuer: tenant.name_i18n?.[locale] ?? tenant.name,
      verifyUrl: '',
    };
    if (n.entity_type === 'PAYMENT_ADVICE') {
      const pa = await tx.maybeOne(`SELECT pa_number, amount, due_at FROM payment_advices WHERE id = $1`, [n.entity_id]);
      if (pa) Object.assign(vars, { number: pa.pa_number, amount: money(pa.amount), dueDate: day(pa.due_at), payUrl: payLinkUrl(this.config, tx.tenantId, n.entity_id) });
    }
    if (n.entity_type === 'INSPECTION') {
      const i = await tx.maybeOne(
        `SELECT l.log_number, i.completed_at, ins.name, ins.name_i18n, ins.identifier
           FROM inspections i JOIN inspection_logs l ON l.id = i.log_id JOIN inspectables ins ON ins.id = l.inspectable_id
          WHERE i.id = $1`,
        [n.entity_id],
      );
      const f = await tx.query(
        `SELECT vt.code, vt.description_i18n, f.fine_amount, f.resolve_by FROM inspection_findings f
           JOIN violation_templates vt ON vt.id = f.violation_template_id
          WHERE f.inspection_id = $1 AND f.status <> 'CANCELLED' ORDER BY vt.code`,
        [n.entity_id],
      );
      const line = (x: any, l: string) => `- ${x.code}: ${x.description_i18n?.[l] ?? ''}`;
      Object.assign(vars, {
        logNumber: i?.log_number,
        siteName: i?.name_i18n?.[locale] ?? i?.name,
        siteIdentifier: i?.identifier,
        date: day(i?.completed_at),
        totalFine: money(f.reduce((s: number, x: any) => s + Number(x.fine_amount ?? 0), 0)),
        followUpDate: f.map((x: any) => day(x.resolve_by)).sort()[0] ?? '-',
        findingsAr: f.map((x: any) => line(x, 'ar-AE')).join('\n'),
        findingsEn: f.map((x: any) => line(x, 'en-US')).join('\n'),
      });
    }
    return vars;
  }

  private async template(tx: TenantTx, code: string, channel: Channel, lang: 'ar' | 'en'): Promise<Template> {
    const own = await tx.maybeOne<{ subject: string | null; body: string }>(
      `SELECT subject, body FROM notification_templates WHERE code = $1 AND channel = $2 AND locale = $3`,
      [code, channel, lang === 'ar' ? 'ar-AE' : 'en-US'],
    );
    if (own) return { subject: own.subject ?? undefined, body: own.body };
    const builtIn = DEFAULT_TEMPLATES[code]?.[channel]?.[lang];
    if (!builtIn) throw new Error(`No template ${code}/${channel}/${lang}`);
    return builtIn;
  }

  private async setting<T>(tx: TenantTx, key: string, fallback: T): Promise<T> {
    const row = await tx.maybeOne<{ value: T }>(`SELECT value FROM tenant_settings WHERE key = $1`, [key]);
    return row ? row.value : fallback;
  }
}
