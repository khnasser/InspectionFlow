/**
 * Inspection report HTML (Arabic RTL by default). The same HTML is rendered to
 * PDF by headless Chromium (Gotenberg in production, Playwright locally), which
 * shapes Arabic correctly. Fonts and photos are inlined so rendering needs no
 * network access.
 */
import { readFileSync } from 'fs';

let fontCss: string | null = null;
/** Noto Naskh Arabic (OFL), embedded as base64 @font-face so PDFs look the same everywhere. */
export function embeddedFonts(): string {
  if (fontCss !== null) return fontCss;
  try {
    const dir = require.resolve('@fontsource/noto-naskh-arabic/package.json').replace(/package\.json$/, 'files/');
    fontCss = [400, 700]
      .flatMap((w) =>
        ['arabic', 'latin'].map((subset) => {
          const file = `${dir}noto-naskh-arabic-${subset}-${w}-normal.woff2`;
          const b64 = readFileSync(file).toString('base64');
          return `@font-face{font-family:"Noto Naskh Arabic";font-style:normal;font-weight:${w};font-display:block;src:url(data:font/woff2;base64,${b64}) format("woff2")}`;
        }),
      )
      .join('\n');
  } catch {
    fontCss = '';
  }
  return fontCss;
}

export interface ReportExtras {
  /** Issued reports carry a number and QR; previews are marked as such. */
  issued?: { reportNumber: string; verifyUrl: string; qrSvg: string; issuedAt: string };
  photos?: Array<{ ownerId: string; dataUrl: string; capturedAt: string | null }>;
  tenantName?: string;
  pdf?: boolean;
}

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
    evidence: 'الأدلة المصورة',
    general: 'صور عامة للموقع',
    reportNo: 'رقم التقرير',
    issuedAt: 'تاريخ الإصدار',
    verify: 'للتحقق من صحة هذا التقرير امسح الرمز أو افتح الرابط',
    preview: 'معاينة — ليست وثيقة صادرة',
    sev: { MINOR: 'بسيطة', MAJOR: 'جسيمة', CRITICAL: 'حرجة' } as Record<string, string>,
    st: { APPROVED: 'معتمد', UNDER_REVIEW: 'قيد المراجعة', COMMITTEE_REVIEW: 'لدى اللجنة', MORE_INFO: 'بانتظار معلومات', REJECTED: 'مرفوض' } as Record<string, string>,
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
    evidence: 'Photo evidence',
    general: 'General site photos',
    reportNo: 'Report number',
    issuedAt: 'Issued',
    verify: 'Scan the code or open the link to verify this report',
    preview: 'Preview — not an issued document',
    sev: { MINOR: 'Minor', MAJOR: 'Major', CRITICAL: 'Critical' } as Record<string, string>,
    st: { APPROVED: 'Approved', UNDER_REVIEW: 'Under review', COMMITTEE_REVIEW: 'With committee', MORE_INFO: 'Waiting for information', REJECTED: 'Rejected' } as Record<string, string>,
  },
};

export function renderInspectionReport(d: any, lang: 'ar' | 'en', x: ReportExtras = {}): string {
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
  const photos = x.photos ?? [];
  const photoBlock = (title: string, list: typeof photos) =>
    list.length
      ? `<section class="ev"><h3>${esc(title)}</h3><div class="photos">${list
          .map((p) => `<figure><img src="${p.dataUrl}" alt=""><figcaption>${esc(p.capturedAt?.slice(0, 16).replace('T', ' ') ?? '')}</figcaption></figure>`)
          .join('')}</div></section>`
      : '';
  const evidence = photos.length
    ? `<h2>${t.evidence}</h2>${d.findings
        .map((f: any) => photoBlock(`${f.violationCode} — ${desc(f)}`, photos.filter((p) => p.ownerId === f.id)))
        .join('')}${photoBlock(t.general, photos.filter((p) => p.ownerId === d.inspectionId))}`
    : '';
  const header = x.issued
    ? `<div class="issued"><div><div>${t.reportNo}: <b>${esc(x.issued.reportNumber)}</b></div>
         <div>${t.issuedAt}: ${esc(x.issued.issuedAt.slice(0, 16).replace('T', ' '))} UTC</div>
         <div class="small">${t.verify}<br><span dir="ltr">${esc(x.issued.verifyUrl)}</span></div></div>
         <div class="qr">${x.issued.qrSvg}</div></div>`
    : `<div class="preview">${t.preview}</div>`;
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head><meta charset="utf-8"><title>${t.title} ${esc(d.logNumber)}</title>
<style>
  ${x.pdf ? embeddedFonts() : ''}
  @page{size:A4;margin:16mm 14mm}
  body{font-family:"Noto Naskh Arabic","Noto Sans Arabic","Segoe UI",Arial,sans-serif;margin:${x.pdf ? 0 : '32px'};color:#1d2433}
  .org{font-size:13px;color:#4a5568;margin-bottom:4px}
  .issued{display:flex;justify-content:space-between;align-items:center;gap:16px;border:1px solid #c9ced6;border-radius:6px;padding:10px 14px;margin:8px 0 16px;font-size:13px}
  .issued .small{font-size:11px;color:#4a5568;margin-top:4px} .qr svg{width:96px;height:96px;display:block}
  .preview{border:1px dashed #b7791f;color:#975a16;padding:6px 10px;margin:8px 0 16px;font-size:13px}
  .photos{display:flex;flex-wrap:wrap;gap:8px} figure{margin:0;width:31%;break-inside:avoid}
  figure img{width:100%;height:150px;object-fit:cover;border:1px solid #c9ced6;border-radius:4px}
  figcaption{font-size:10px;color:#4a5568} h2{font-size:17px;margin:18px 0 6px} h3{font-size:14px;margin:12px 0 6px}
  tr{break-inside:avoid} h2,h3{break-after:avoid} .ev{break-inside:avoid-page}
  h1{font-size:22px;margin:0 0 16px} table{border-collapse:collapse;width:100%;margin:12px 0}
  th,td{border:1px solid #c9ced6;padding:6px 8px;text-align:start;font-size:13px} th{background:#f1f3f6}
  .num{text-align:end;font-variant-numeric:tabular-nums} .meta td{border:none;padding:2px 8px}
</style></head>
<body>
${x.tenantName ? `<div class="org">${esc(x.tenantName)}</div>` : ''}
<h1>${t.title}</h1>
${header}
<table class="meta">
  <tr><td>${t.log}</td><td>${esc(d.logNumber)}</td><td>${t.cycle}</td><td>${esc(d.cycleNumber)}</td></tr>
  <tr><td>${t.site}</td><td>${esc(d.inspectable_name_i18n?.[locale] ?? d.inspectable_name)} (${esc(d.identifier)})</td><td>${t.date}</td><td>${esc(new Date(d.completed_at).toISOString().slice(0, 16).replace('T', ' '))}</td></tr>
  <tr><td>${t.inspector}</td><td>${esc(d.inspector)}</td><td>${t.status}</td><td>${esc(t.st[d.status] ?? d.status)}</td></tr>
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
${evidence}
</body></html>`;
}
