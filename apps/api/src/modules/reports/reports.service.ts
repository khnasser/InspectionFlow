import { Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import QRCode from 'qrcode';
import { uuidv7 } from '@inspectionflow/engine';
import { AuditService } from '../../common/audit.service';
import { APP_CONFIG, AppConfig } from '../../common/config';
import { DbService, TenantTx } from '../../common/db.service';
import { objectKey, STORAGE, StoragePort } from '../../common/storage';
import { DocumentsService } from '../documents/documents.service';
import { InspectionService } from '../inspections/inspection.service';
import { renderInspectionReport, ReportExtras } from '../inspections/report';
import { PDF_RENDERER, PdfRenderer } from './pdf';
export { newVerificationCode, queueInspectionReport } from './report-queue';

const EMBEDDABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PHOTOS = 24;
@Injectable()
export class ReportsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ReportWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly inspections: InspectionService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(PDF_RENDERER) private readonly renderer: PdfRenderer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    if (this.config.reports.worker) {
      this.timer = setInterval(() => void this.runOnce().catch((e) => this.log.error(e)), this.config.reports.workerIntervalMs);
      this.timer.unref();
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.renderer.close?.();
  }

  verifyUrl(code: string) {
    return `${this.config.reports.verifyBaseUrl.replace(/\/$/, '')}/verify/${code}`;
  }

  /** Report HTML for an inspection: everything needed, read in one tenant transaction. */
  private async compose(tx: TenantTx, inspectionId: string, lang: 'ar' | 'en', issued?: ReportExtras['issued'], pdf = true) {
    const d = await this.inspections.detail(tx, inspectionId);
    const tenant = await tx.one<{ name: string; name_i18n: Record<string, string> | null }>(
      `SELECT name, name_i18n FROM tenants WHERE id = $1`,
      [tx.tenantId],
    );
    const evidence = await this.documents.forInspection(tx, inspectionId, d.findings.map((f: { id: string }) => f.id));
    const photos: NonNullable<ReportExtras['photos']> = [];
    for (const e of evidence.filter((x) => x.status === 'AVAILABLE' && EMBEDDABLE.has(x.mimeType)).slice(0, MAX_PHOTOS)) {
      const doc = await this.documents.get(tx, e.id);
      const bytes = await this.documents.read(doc.key);
      photos.push({ ownerId: e.ownerId, capturedAt: e.capturedAt, dataUrl: `data:${e.mimeType};base64,${bytes.toString('base64')}` });
    }
    const tenantName = tenant.name_i18n?.[lang === 'ar' ? 'ar-AE' : 'en-US'] ?? tenant.name;
    return renderInspectionReport(d, lang, { issued, photos, tenantName, pdf });
  }

  /** On-demand PDF. Returns the issued copy when there is one, otherwise a marked preview. */
  async pdfFor(tenantId: string, userId: string, inspectionId: string, lang: 'ar' | 'en', preview: boolean) {
    const issued = await this.db.withTenant(tenantId, userId, async (tx) => {
      await this.inspections.summary(tx, inspectionId); // 404 if not visible
      return tx.maybeOne(
        `SELECT g.report_number, g.pdf_sha256, v.s3_key FROM generated_reports g
           JOIN document_versions v ON v.document_id = g.document_id AND v.version_no = 1
          WHERE g.subject_type = 'INSPECTION' AND g.subject_id = $1 AND g.status = 'ISSUED'
          ORDER BY g.reissue_no DESC LIMIT 1`,
        [inspectionId],
      );
    });
    if (issued && !preview) {
      return { pdf: await this.storage.get(issued.s3_key), fileName: `${issued.report_number}.pdf`, issued: true };
    }
    const html = await this.db.withTenant(tenantId, userId, (tx) => this.compose(tx, inspectionId, lang));
    return { pdf: await this.renderer.render(html), fileName: `inspection-${inspectionId}-preview.pdf`, issued: false };
  }

  async listFor(tx: TenantTx, inspectionId: string) {
    const rows = await tx.query(
      `SELECT id, report_number, reissue_no, locale, status, verification_code, pdf_sha256, issued_at, last_error
         FROM generated_reports WHERE subject_type = 'INSPECTION' AND subject_id = $1 ORDER BY reissue_no`,
      [inspectionId],
    );
    return rows.map((r) => ({
      id: r.id,
      reportNumber: r.report_number,
      reissueNo: r.reissue_no,
      locale: r.locale,
      status: r.status,
      verificationCode: r.status === 'ISSUED' ? r.verification_code : null,
      verifyUrl: r.status === 'ISSUED' ? this.verifyUrl(r.verification_code) : null,
      pdfSha256: r.pdf_sha256,
      issuedAt: r.issued_at,
    }));
  }

  /** Claim and render pending reports. Safe to run on several API instances at once. */
  async runOnce(limit = 5): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const jobs = await this.db.system<{ id: string; tenant_id: string }>('SELECT * FROM claim_report_jobs($1)', [limit]);
      for (const job of jobs) await this.process(job.id, job.tenant_id);
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  private async process(jobId: string, tenantId: string) {
    try {
      const job = await this.db.withTenant(tenantId, null, (tx) =>
        tx.one(`SELECT id, subject_id, report_number, locale, verification_code, attempts FROM generated_reports WHERE id = $1`, [jobId]),
      );
      const issuedAt = new Date().toISOString();
      const verifyUrl = this.verifyUrl(job.verification_code);
      const qrSvg = await QRCode.toString(verifyUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 0 });
      const lang = String(job.locale).startsWith('en') ? 'en' : 'ar';
      const html = await this.db.withTenant(tenantId, null, (tx) =>
        this.compose(tx, job.subject_id, lang, { reportNumber: job.report_number, verifyUrl, qrSvg, issuedAt }),
      );
      const pdf = await this.renderer.render(html);
      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const docId = uuidv7();
      const key = objectKey(tenantId, 'REPORT', job.subject_id, docId);
      await this.storage.put(key, pdf, 'application/pdf');
      await this.db.withTenant(tenantId, null, async (tx) => {
        await tx.query(
          `INSERT INTO documents (id, tenant_id, owner_type, owner_id, doc_type, category, file_name, mime_type, retention_class, status)
           VALUES ($1,$2,'REPORT',$3,'PDF','report',$4,'application/pdf','LEGAL_10Y','AVAILABLE')`,
          [docId, tenantId, job.subject_id, `${job.report_number}.pdf`],
        );
        await tx.query(
          `INSERT INTO document_versions (tenant_id, document_id, version_no, s3_bucket, s3_key, size_bytes, sha256)
           VALUES ($1,$2,1,$3,$4,$5,$6)`,
          [tenantId, docId, this.storage.bucket, key, pdf.length, sha256],
        );
        await tx.query(
          `UPDATE generated_reports SET status = 'ISSUED', document_id = $2, pdf_sha256 = $3, issued_at = $4, last_error = NULL
            WHERE id = $1`,
          [jobId, docId, sha256, issuedAt],
        );
        await this.audit.record(tx, {
          action: 'report.issued',
          entityType: 'INSPECTION',
          entityId: job.subject_id,
          newValue: { reportNumber: job.report_number, sha256, documentId: docId },
        });
      });
    } catch (err) {
      this.log.warn(`Report ${jobId} failed: ${(err as Error).message}`);
      await this.db.withTenant(tenantId, null, (tx) =>
        tx.query(
          `UPDATE generated_reports SET status = CASE WHEN attempts >= 5 THEN 'FAILED' ELSE 'PENDING' END, last_error = $2, locked_at = NULL
            WHERE id = $1`,
          [jobId, String((err as Error).message).slice(0, 1000)],
        ),
      );
    }
  }

  /** Public verification (no sign-in): only non-personal facts about the document. */
  async verify(code: string) {
    if (!/^[0-9A-HJKMNP-TV-Z]{16}$/.test(code)) throw new NotFoundException('Unknown verification code');
    const rows = await this.db.system('SELECT * FROM verify_document($1)', [code]);
    if (!rows.length) throw new NotFoundException('Unknown verification code');
    const r = rows[0];
    return {
      valid: r.status === 'ISSUED',
      status: r.status,
      issuer: { en: r.issuer_en, ar: r.issuer_ar },
      documentType: r.template_code,
      reportNumber: r.report_number,
      reissueNo: r.reissue_no,
      issuedAt: r.issued_at,
      pdfSha256: r.pdf_sha256,
      inspectionStatus: r.subject_status,
    };
  }
}
