/**
 * Bilingual HTML inspection report (Arabic RTL by default). In production the
 * same HTML is rendered to PDF by the report worker (headless Chromium), which
 * shapes Arabic correctly without per-glyph handling.
 */

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const L = {
  ar: {
    title: 'تقرير التفتيش',
    log: 'رقم السجل',
    cycle: 'الدورة',
    date: 'تاريخ التفتيش',
    inspector: 'المفتش',
    site: 'الموقع',
    status: 'الحالة',
    category: 'التصنيف',
    findings: 'المخالفات والملاحظات',
    code: 'الرمز',
    description: 'الوصف',
    occurrence: 'التكرار',
    severity: 'الخطورة',
    fine: 'الغرامة (درهم)',
    resolveBy: 'تاريخ التصحيح',
    total: 'إجمالي الغرامات',
    followUp: 'تاريخ المتابعة',
    pa: 'إشعار الدفع',
    signature: 'توقيع العميل',
    none: 'لا توجد مخالفات',
    sev: { MINOR: 'بسيطة', MAJOR: 'جسيمة', CRITICAL: 'حرجة' } as Record<string, string>,
  },
  en: {
    title: 'Inspection report',
    log: 'Log number',
    cycle: 'Cycle',
    date: 'Inspection date',
    inspector: 'Inspector',
    site: 'Site',
    status: 'Status',
    category: 'Category',
    findings: 'Findings',
    code: 'Code',
    description: 'Description',
    occurrence: 'Occurrence',
    severity: 'Severity',
    fine: 'Fine (AED)',
    resolveBy: 'Resolve by',
    total: 'Total fines',
    followUp: 'Follow-up date',
    pa: 'Payment advice',
    signature: 'Client signature',
    none: 'No findings',
    sev: { MINOR: 'Minor', MAJOR: 'Major', CRITICAL: 'Critical' } as Record<string, string>,
  },
};

export function renderInspectionReport(d: any, lang: 'ar' | 'en'): string {
  const t = L[lang];
  const locale = lang === 'ar' ? 'ar-AE' : 'en-US';
  const money = (n: number) => new Intl.NumberFormat(locale, { minimumFractionDigits: 2 }).format(n);
  const desc = (f: any) => {
    const detail = (d.findingDetails ?? []).find((x: any) => x.id === f.id);
    const i18n = detail?.description_i18n ?? {};
    return i18n[locale] ?? i18n['en-US'] ?? i18n['ar-AE'] ?? f.violationCode;
  };
  const rows = d.findings.length
    ? d.findings
        .map(
          (f: any) => `<tr><td>${esc(f.violationCode)}</td><td>${esc(desc(f))}</td><td>${esc(f.occurrence)}</td>
            <td>${esc(t.sev[f.severity] ?? f.severity)}</td><td class="num">${money(f.fine)}</td><td>${esc(f.resolveBy)}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="6">${t.none}</td></tr>`;
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head><meta charset="utf-8"><title>${t.title} ${esc(d.logNumber)}</title>
<style>
  body{font-family:"Noto Naskh Arabic","Noto Sans Arabic","Segoe UI",Arial,sans-serif;margin:32px;color:#1d2433}
  h1{font-size:22px;margin:0 0 16px} table{border-collapse:collapse;width:100%;margin:12px 0}
  th,td{border:1px solid #c9ced6;padding:6px 8px;text-align:start;font-size:13px} th{background:#f1f3f6}
  .num{text-align:end;font-variant-numeric:tabular-nums} .meta td{border:none;padding:2px 8px}
</style></head>
<body>
<h1>${t.title}</h1>
<table class="meta">
  <tr><td>${t.log}</td><td>${esc(d.logNumber)}</td><td>${t.cycle}</td><td>${esc(d.cycleNumber)}</td></tr>
  <tr><td>${t.site}</td><td>${esc(d.inspectable_name)} (${esc(d.identifier)})</td><td>${t.date}</td><td>${esc(new Date(d.completed_at).toISOString().slice(0, 16).replace('T', ' '))}</td></tr>
  <tr><td>${t.inspector}</td><td>${esc(d.inspector)}</td><td>${t.status}</td><td>${esc(d.status)}</td></tr>
</table>
<h2>${t.findings}</h2>
<table><thead><tr><th>${t.code}</th><th>${t.description}</th><th>${t.occurrence}</th><th>${t.severity}</th><th>${t.fine}</th><th>${t.resolveBy}</th></tr></thead>
<tbody>${rows}</tbody></table>
<table class="meta">
  <tr><td>${t.total}</td><td class="num">${money(d.totalFine)}</td></tr>
  <tr><td>${t.followUp}</td><td>${esc(d.followUpDate ?? '-')}</td></tr>
  ${d.paymentAdvice ? `<tr><td>${t.pa}</td><td>${esc(d.paymentAdvice.number)}</td></tr>` : ''}
  ${d.signature ? `<tr><td>${t.signature}</td><td>${esc(d.signature.signer_name)}</td></tr>` : ''}
</table>
</body></html>`;
}
