/**
 * Built-in bilingual templates. A tenant can override any of them per channel
 * and locale in `notification_templates` (edited in Configuration Studio).
 * Placeholders: {{name}}; values are HTML-escaped in email HTML.
 */
export type Channel = 'EMAIL' | 'SMS' | 'PUSH' | 'IN_APP' | 'WHATSAPP';
export interface Template {
  subject?: string;
  body: string;
}
type Bilingual = { ar: Template; en: Template };

const letter = (ar: string, en: string): Bilingual => ({
  ar: {
    subject: `${ar} — {{logNumber}}`,
    body: `السادة {{partyName}}،\n\nنفيدكم بصدور ${ar} لموقعكم {{siteName}} ({{siteIdentifier}}) بتاريخ {{date}}.\n{{findingsAr}}\nإجمالي الغرامات: {{totalFine}} درهم.\nتاريخ المتابعة: {{followUpDate}}.\n\nالتقرير مرفق، ويمكن التحقق منه عبر: {{verifyUrl}}\n\n{{issuer}}`,
  },
  en: {
    subject: `${en} — {{logNumber}}`,
    body: `Dear {{partyName}},\n\nPlease find the ${en.toLowerCase()} for {{siteName}} ({{siteIdentifier}}) dated {{date}}.\n{{findingsEn}}\nTotal fines: AED {{totalFine}}.\nFollow-up date: {{followUpDate}}.\n\nThe report is attached. Verify it at: {{verifyUrl}}\n\n{{issuer}}`,
  },
});

export const DEFAULT_TEMPLATES: Record<string, Partial<Record<Channel, Bilingual>>> = {
  INSPECTION_REPORT: { EMAIL: letter('تقرير التفتيش', 'Inspection report') },
  WARNING_LETTER: { EMAIL: letter('إنذار', 'Warning') },
  PENALTY_LETTER: { EMAIL: letter('إشعار مخالفة وغرامة', 'Penalty notice') },
  PAYMENT_ADVICE_ISSUED: {
    EMAIL: {
      ar: {
        subject: 'إشعار دفع {{number}}',
        body: 'السادة {{partyName}}،\n\nصدر إشعار الدفع رقم {{number}} بمبلغ {{amount}} درهم، ويستحق السداد قبل {{dueDate}}.\nللدفع: {{payUrl}}\n\n{{issuer}}',
      },
      en: {
        subject: 'Payment advice {{number}}',
        body: 'Dear {{partyName}},\n\nPayment advice {{number}} for AED {{amount}} has been issued and is due by {{dueDate}}.\nPay online: {{payUrl}}\n\n{{issuer}}',
      },
    },
    SMS: {
      ar: { body: 'إشعار دفع {{number}} بمبلغ {{amount}} درهم، يستحق قبل {{dueDate}}. للدفع: {{payUrl}}' },
      en: { body: 'Payment advice {{number}}: AED {{amount}} due by {{dueDate}}. Pay: {{payUrl}}' },
    },
  },
  PAYMENT_REMINDER: {
    EMAIL: {
      ar: { subject: 'تذكير: إشعار الدفع {{number}}', body: 'السادة {{partyName}}،\n\nنذكركم بأن إشعار الدفع رقم {{number}} بمبلغ {{amount}} درهم يستحق قبل {{dueDate}}.\nللدفع: {{payUrl}}\n\n{{issuer}}' },
      en: { subject: 'Reminder: payment advice {{number}}', body: 'Dear {{partyName}},\n\nA reminder that payment advice {{number}} for AED {{amount}} is due by {{dueDate}}.\nPay online: {{payUrl}}\n\n{{issuer}}' },
    },
    SMS: {
      ar: { body: 'تذكير: إشعار الدفع {{number}} بمبلغ {{amount}} درهم يستحق قبل {{dueDate}}. للدفع: {{payUrl}}' },
      en: { body: 'Reminder: payment advice {{number}}, AED {{amount}}, due {{dueDate}}. Pay: {{payUrl}}' },
    },
  },
  PAYMENT_OVERDUE: {
    EMAIL: {
      ar: { subject: 'متأخر السداد: إشعار الدفع {{number}}', body: 'السادة {{partyName}}،\n\nلم يتم سداد إشعار الدفع رقم {{number}} بمبلغ {{amount}} درهم في موعده ({{dueDate}}). قد يؤدي ذلك إلى إيقاف الخدمات المرتبطة بالترخيص حتى السداد.\nللدفع: {{payUrl}}\n\n{{issuer}}' },
      en: { subject: 'Overdue: payment advice {{number}}', body: 'Dear {{partyName}},\n\nPayment advice {{number}} for AED {{amount}} was due on {{dueDate}} and is unpaid. Licence-related services may be blocked until it is paid.\nPay online: {{payUrl}}\n\n{{issuer}}' },
    },
    SMS: {
      ar: { body: 'إشعار الدفع {{number}} ({{amount}} درهم) متأخر السداد منذ {{dueDate}}. للدفع: {{payUrl}}' },
      en: { body: 'Payment advice {{number}} (AED {{amount}}) is overdue since {{dueDate}}. Pay: {{payUrl}}' },
    },
  },
  TASK_ESCALATED: {
    IN_APP: {
      ar: { subject: 'مهمة متأخرة', body: 'مهمة {{taskType}} — {{siteName}} المسندة إلى {{assignee}} متأخرة منذ {{dueDate}}.' },
      en: { subject: 'Overdue task', body: '{{taskType}} task — {{siteName}}, assigned to {{assignee}}, is overdue since {{dueDate}}.' },
    },
  },
  FINDING_DUE: {
    IN_APP: {
      ar: { subject: 'موعد تصحيح مخالفة', body: 'حان موعد التحقق من تصحيح المخالفة {{code}} في {{siteName}} ({{logNumber}}).' },
      en: { subject: 'Finding due', body: 'Finding {{code}} at {{siteName}} ({{logNumber}}) is due for a close-out check.' },
    },
  },
  TASK_ASSIGNED: {
    IN_APP: {
      ar: { subject: 'مهمة جديدة', body: 'أسندت إليك مهمة {{taskType}} — {{siteName}}، تستحق في {{dueDate}}.' },
      en: { subject: 'New task', body: 'You have a new {{taskType}} task — {{siteName}}, due {{dueDate}}.' },
    },
  },
};

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function fill(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

/** Plain text to a minimal, right-to-left-aware HTML email (no external assets). */
export function toHtml(text: string, lang: 'ar' | 'en'): string {
  const body = escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>');
  return `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><body style="font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1d2433">${body}</body></html>`;
}
