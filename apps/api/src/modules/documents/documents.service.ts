import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import { AuthUser } from '../../common/auth';
import { APP_CONFIG, AppConfig } from '../../common/config';
import { TenantTx } from '../../common/db.service';
import { objectKey, STORAGE, StoragePort } from '../../common/storage';

export const ALLOWED_MIME: Record<string, 'PHOTO' | 'VIDEO' | 'PDF'> = {
  'image/jpeg': 'PHOTO',
  'image/png': 'PHOTO',
  'image/webp': 'PHOTO',
  'image/heic': 'PHOTO',
  'video/mp4': 'VIDEO',
  'application/pdf': 'PDF',
};

export const initiateUploadSchema = z.object({
  /** Device-generated UUID v7: lets the device reference the photo before it is uploaded. */
  id: z.string().uuid(),
  ownerType: z.enum(['FINDING', 'INSPECTION']),
  ownerId: z.string().uuid(),
  mimeType: z.string().refine((m) => m in ALLOWED_MIME, 'unsupported file type'),
  fileName: z.string().max(200).optional(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  capturedAt: z.string().datetime({ offset: true }).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});
export type InitiateUpload = z.infer<typeof initiateUploadSchema>;

export interface EvidenceItem {
  id: string;
  ownerType: string;
  ownerId: string;
  status: string;
  mimeType: string;
  fileName: string | null;
  sizeBytes: number;
  sha256: string;
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  url: string | null;
}

/**
 * Evidence upload, offline-first: the device names each photo with its own id
 * and owner (finding or inspection id it also generated), so a photo can be
 * uploaded before or after the inspection itself reaches the server.
 *   1. POST /v1/documents            -> signed PUT URL bound to size + SHA-256
 *   2. PUT  <url>                    -> straight to object storage
 *   3. POST /v1/documents/:id/complete -> server checks the object, marks AVAILABLE
 * Evidence is immutable once AVAILABLE; the SHA-256 goes to the audit chain.
 */
@Injectable()
export class DocumentsService {
  constructor(
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  private async assertOwner(tx: TenantTx, user: AuthUser, ownerType: string, ownerId: string) {
    const owner =
      ownerType === 'FINDING'
        ? await tx.maybeOne<{ performed_by: string }>(
            `SELECT i.performed_by FROM inspection_findings f JOIN inspections i ON i.id = f.inspection_id WHERE f.id = $1`,
            [ownerId],
          )
        : await tx.maybeOne<{ performed_by: string }>(`SELECT performed_by FROM inspections WHERE id = $1`, [ownerId]);
    // Not on the server yet: the inspection is still in the device outbox.
    if (owner && owner.performed_by !== user.userId) {
      throw new ForbiddenException('Only the inspector who recorded this can add evidence');
    }
  }

  async initiate(tx: TenantTx, user: AuthUser, input: InitiateUpload) {
    if (input.sizeBytes > this.config.storage.maxUploadBytes) {
      throw new BadRequestException(`File larger than ${this.config.storage.maxUploadBytes} bytes`);
    }
    const existing = await tx.maybeOne(
      `SELECT d.id, d.status, d.owner_type, d.owner_id, d.mime_type, d.uploaded_by, v.sha256, v.size_bytes, v.s3_key
         FROM documents d JOIN document_versions v ON v.document_id = d.id AND v.version_no = d.current_version
        WHERE d.id = $1`,
      [input.id],
    );
    if (existing) {
      // Idempotent retry from the device.
      if (existing.sha256 !== input.sha256 || existing.owner_id !== input.ownerId || existing.uploaded_by !== user.userId) {
        throw new ConflictException('Document id already used for different content');
      }
      if (existing.status === 'AVAILABLE') return { id: input.id, status: 'AVAILABLE', upload: null };
      if (existing.status !== 'PENDING') throw new ConflictException(`Document is ${existing.status}`);
      const upload = await this.storage.uploadTarget(existing.s3_key, {
        contentType: existing.mime_type,
        sha256: existing.sha256,
        size: Number(existing.size_bytes),
      });
      return { id: input.id, status: 'PENDING', upload };
    }

    await this.assertOwner(tx, user, input.ownerType, input.ownerId);
    const key = objectKey(tx.tenantId, input.ownerType, input.ownerId, input.id);
    await tx.query(
      `INSERT INTO documents (id, tenant_id, owner_type, owner_id, doc_type, category, file_name, mime_type, uploaded_by, status)
       VALUES ($1,$2,$3,$4,$5,'evidence',$6,$7,$8,'PENDING')`,
      [input.id, tx.tenantId, input.ownerType, input.ownerId, ALLOWED_MIME[input.mimeType], input.fileName ?? null, input.mimeType, user.userId],
    );
    await tx.query(
      `INSERT INTO document_versions (tenant_id, document_id, version_no, s3_bucket, s3_key, size_bytes, sha256, captured_at, latitude, longitude)
       VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9)`,
      [tx.tenantId, input.id, this.storage.bucket, key, input.sizeBytes, input.sha256, input.capturedAt ?? null, input.latitude ?? null, input.longitude ?? null],
    );
    const upload = await this.storage.uploadTarget(key, { contentType: input.mimeType, sha256: input.sha256, size: input.sizeBytes });
    return { id: input.id, status: 'PENDING', upload };
  }

  async complete(tx: TenantTx, user: AuthUser, id: string) {
    const d = await tx.maybeOne(
      `SELECT d.id, d.status, d.owner_type, d.owner_id, d.uploaded_by, v.sha256, v.size_bytes, v.s3_key
         FROM documents d JOIN document_versions v ON v.document_id = d.id AND v.version_no = d.current_version
        WHERE d.id = $1 FOR UPDATE OF d`,
      [id],
    );
    if (!d) throw new NotFoundException('Document not found');
    if (d.uploaded_by !== user.userId) throw new ForbiddenException('Not your upload');
    if (d.status === 'AVAILABLE') return { id, status: 'AVAILABLE' };
    if (d.status !== 'PENDING') throw new ConflictException(`Document is ${d.status}`);

    const obj = await this.storage.head(d.s3_key);
    if (!obj) throw new ConflictException('File not uploaded yet');
    if (obj.size !== Number(d.size_bytes) || (obj.sha256 !== null && obj.sha256 !== d.sha256)) {
      await this.storage.delete(d.s3_key);
      await tx.query(`UPDATE documents SET status = 'REJECTED' WHERE id = $1`, [id]);
      await this.audit.record(tx, { action: 'document.rejected', entityType: 'DOCUMENT', entityId: id, newValue: { reason: 'checksum mismatch' } });
      return { id, status: 'REJECTED' };
    }
    await tx.query(`UPDATE documents SET status = 'AVAILABLE' WHERE id = $1`, [id]);
    await this.audit.record(tx, {
      action: 'document.uploaded',
      entityType: 'DOCUMENT',
      entityId: id,
      newValue: { ownerType: d.owner_type, ownerId: d.owner_id, sha256: d.sha256, size: Number(d.size_bytes) },
    });
    return { id, status: 'AVAILABLE' };
  }

  /** Evidence for an inspection and its findings, with short-lived download URLs. */
  async forInspection(tx: TenantTx, inspectionId: string, findingIds: string[]): Promise<EvidenceItem[]> {
    const rows = await tx.query(
      `SELECT d.id, d.owner_type, d.owner_id, d.status, d.mime_type, d.file_name, v.size_bytes, v.sha256, v.s3_key,
              v.captured_at, v.latitude, v.longitude
         FROM documents d JOIN document_versions v ON v.document_id = d.id AND v.version_no = d.current_version
        WHERE d.category = 'evidence' AND d.status IN ('PENDING','AVAILABLE')
          AND ((d.owner_type = 'INSPECTION' AND d.owner_id = $1) OR (d.owner_type = 'FINDING' AND d.owner_id = ANY($2::uuid[])))
        ORDER BY v.captured_at NULLS LAST, d.id`,
      [inspectionId, findingIds],
    );
    return Promise.all(rows.map((r) => this.toItem(r)));
  }

  async get(tx: TenantTx, id: string): Promise<EvidenceItem & { key: string }> {
    const r = await tx.maybeOne(
      `SELECT d.id, d.owner_type, d.owner_id, d.status, d.mime_type, d.file_name, v.size_bytes, v.sha256, v.s3_key,
              v.captured_at, v.latitude, v.longitude
         FROM documents d JOIN document_versions v ON v.document_id = d.id AND v.version_no = d.current_version
        WHERE d.id = $1`,
      [id],
    );
    if (!r) throw new NotFoundException('Document not found');
    return { ...(await this.toItem(r)), key: r.s3_key };
  }

  private async toItem(r: any): Promise<EvidenceItem> {
    return {
      id: r.id,
      ownerType: r.owner_type,
      ownerId: r.owner_id,
      status: r.status,
      mimeType: r.mime_type,
      fileName: r.file_name,
      sizeBytes: Number(r.size_bytes),
      sha256: r.sha256,
      capturedAt: r.captured_at ? new Date(r.captured_at).toISOString() : null,
      latitude: r.latitude === null ? null : Number(r.latitude),
      longitude: r.longitude === null ? null : Number(r.longitude),
      url:
        r.status === 'AVAILABLE'
          ? await this.storage.downloadUrl(r.s3_key, { contentType: r.mime_type, fileName: r.file_name ?? undefined })
          : null,
    };
  }

  /** Raw bytes, for embedding photos in the PDF report. */
  read(key: string) {
    return this.storage.get(key);
  }
}
