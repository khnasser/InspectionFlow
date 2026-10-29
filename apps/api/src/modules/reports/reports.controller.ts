import { Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthUser, CurrentUser, Public, Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { ReportsService } from './reports.service';

const STATUS: Record<string, string> = {
  APPROVED: 'معتمد · Approved',
  UNDER_REVIEW: 'قيد المراجعة · Under review',
  COMMITTEE_REVIEW: 'لدى اللجنة · With committee',
  MORE_INFO: 'بانتظار معلومات · Waiting for information',
  REJECTED: 'مرفوض · Rejected',
};

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

@Controller()
export class ReportsController {
  constructor(
    private readonly db: DbService,
    private readonly reports: ReportsService,
  ) {}

  /** The issued PDF when there is one; `?preview=1` (or not yet issued) renders a marked preview. */
  @Get('v1/inspections/:id/report.pdf')
  async pdf(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
    @Query('lang') lang?: string,
    @Query('preview') preview?: string,
  ) {
    const r = await this.reports.pdfFor(user.tenantId, user.userId, id, lang === 'en' ? 'en' : 'ar', preview === '1');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${r.fileName}"`);
    res.setHeader('X-Report-Issued', String(r.issued));
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(r.pdf);
  }

  @Get('v1/inspections/:id/reports')
  list(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.tenantId, user.userId, (tx) => this.reports.listFor(tx, id));
  }

  /** Run the report worker now (operations; the worker also runs on a timer). */
  @Post('v1/admin/reports/run')
  @Roles('ADMIN')
  async run() {
    return { processed: await this.reports.runOnce(20) };
  }

  @Public()
  @Get('v1/verify/:code')
  verify(@Param('code') code: string) {
    return this.reports.verify(code.toUpperCase());
  }

  /** Page the QR code opens: bilingual, no sign-in, no personal data. */
  @Public()
  @Get('verify/:code')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async verifyPage(@Param('code') code: string) {
    let body: string;
    try {
      const v = await this.reports.verify(code.toUpperCase());
      const ok = v.valid;
      body = `<div class="badge ${ok ? 'ok' : 'bad'}">${ok ? 'وثيقة صادرة وصحيحة · Valid issued document' : 'وثيقة ملغاة · Revoked document'}</div>
        <dl>
          <dt>الجهة المصدرة · Issuer</dt><dd>${esc(v.issuer.ar)} · ${esc(v.issuer.en)}</dd>
          <dt>رقم التقرير · Report number</dt><dd dir="ltr">${esc(v.reportNumber)}${v.reissueNo ? ` (reissue ${v.reissueNo})` : ''}</dd>
          <dt>تاريخ الإصدار · Issued</dt><dd dir="ltr">${esc(new Date(v.issuedAt).toISOString().slice(0, 16).replace('T', ' '))} UTC</dd>
          <dt>حالة التفتيش · Inspection status</dt><dd>${esc(STATUS[v.inspectionStatus] ?? v.inspectionStatus)}</dd>
          <dt>البصمة الرقمية للملف (SHA-256) · File fingerprint</dt><dd dir="ltr" class="mono">${esc(v.pdfSha256)}</dd>
        </dl>
        <p class="note">قارن البصمة مع الملف الذي لديك للتأكد من عدم تعديله. · Compare the fingerprint with your copy to confirm it was not altered.</p>`;
    } catch {
      body = `<div class="badge bad">رمز التحقق غير معروف · Unknown verification code</div>`;
    }
    return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>التحقق من وثيقة · Verify document</title>
<style>body{font-family:"Noto Naskh Arabic","Segoe UI",Arial,sans-serif;background:#f3f5f8;color:#1d2433;margin:0;padding:16px}
main{max-width:560px;margin:24px auto;background:#fff;border-radius:10px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 12px}.badge{padding:10px 12px;border-radius:6px;font-weight:700;margin-bottom:12px}
.ok{background:#e6f4ea;color:#1e6b34}.bad{background:#fdecea;color:#a12622}dt{font-size:12px;color:#4a5568;margin-top:10px}
dd{margin:2px 0 0;font-size:15px}.mono{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all}.note{font-size:12px;color:#4a5568}</style>
</head><body><main><h1>التحقق من وثيقة · Document verification</h1>${body}</main></body></html>`;
  }
}
