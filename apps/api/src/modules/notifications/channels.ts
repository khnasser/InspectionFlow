import { AppConfig } from '../../common/config';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
}
export interface SmsMessage {
  to: string;
  text: string;
}
export interface EmailSender {
  send(m: EmailMessage): Promise<{ messageId: string }>;
}
export interface SmsSender {
  /** null = SMS switched off for this deployment. */
  send(m: SmsMessage): Promise<{ messageId: string } | null>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
export const SMS_SENDER = Symbol('SMS_SENDER');

/** In-memory sender for development and tests; refused in production by loadConfig. */
export class CaptureEmail implements EmailSender {
  readonly sent: EmailMessage[] = [];
  failNext = 0;
  async send(m: EmailMessage) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('SMTP 451 temporary failure');
    }
    this.sent.push(m);
    return { messageId: `capture-${this.sent.length}` };
  }
}
export class CaptureSms implements SmsSender {
  readonly sent: SmsMessage[] = [];
  async send(m: SmsMessage) {
    this.sent.push(m);
    return { messageId: `capture-sms-${this.sent.length}` };
  }
}

/** Any SMTP relay: Amazon SES, Microsoft 365, the tenant's own mail server. */
export class SmtpEmail implements EmailSender {
  private transport: any;
  constructor(
    private readonly url: string,
    private readonly from: string,
  ) {}
  async send(m: EmailMessage) {
    this.transport ??= (await import('nodemailer')).createTransport(this.url);
    const info = await this.transport.sendMail({ from: this.from, ...m });
    return { messageId: String(info.messageId) };
  }
}

/** Infobip SMS API v2 (POST /sms/2/text/advanced). Not yet exercised against a live account. */
export class InfobipSms implements SmsSender {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly sender: string,
  ) {}
  async send(m: SmsMessage) {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/sms/2/text/advanced`, {
      method: 'POST',
      headers: { Authorization: `App ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ messages: [{ from: this.sender, destinations: [{ to: m.to.replace(/^\+/, '') }], text: m.text }] }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Infobip ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return { messageId: String(body?.messages?.[0]?.messageId ?? '') };
  }
}

export class NoSms implements SmsSender {
  async send() {
    return null;
  }
}

export function createEmailSender(c: AppConfig): EmailSender {
  return c.notifications.emailDriver === 'smtp' ? new SmtpEmail(c.notifications.smtpUrl, c.notifications.emailFrom) : new CaptureEmail();
}
export function createSmsSender(c: AppConfig): SmsSender {
  const n = c.notifications;
  if (n.smsDriver === 'infobip') return new InfobipSms(n.infobipBaseUrl, n.infobipApiKey, n.smsSender);
  return n.smsDriver === 'none' ? new NoSms() : new CaptureSms();
}
