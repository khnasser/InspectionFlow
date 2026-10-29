import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import { dirname, join, resolve } from 'path';
import { Readable } from 'stream';
import { AppConfig } from './config';

export interface UploadTarget {
  url: string;
  method: 'PUT';
  /** Headers the client must send with the PUT (content type, integrity checksum). */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface StoredObject {
  size: number;
  /** Hex sha256 of the stored bytes when the backend can tell. */
  sha256: string | null;
}

/**
 * Object storage port. Clients upload and download directly with short-lived
 * signed URLs, so evidence never streams through the API in production.
 */
export interface StoragePort {
  readonly bucket: string;
  uploadTarget(key: string, o: { contentType: string; sha256: string; size: number; ttlSeconds?: number }): Promise<UploadTarget>;
  downloadUrl(key: string, o?: { ttlSeconds?: number; fileName?: string; contentType?: string }): Promise<string>;
  head(key: string): Promise<StoredObject | null>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export const STORAGE = Symbol('STORAGE');

const hexToBase64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
const base64ToHex = (b64: string) => Buffer.from(b64, 'base64').toString('hex');

/** AWS S3 or any S3-compatible store (MinIO, Ceph). SSE-KMS is configured on the bucket. */
export class S3Storage implements StoragePort {
  readonly bucket: string;
  private clientPromise: Promise<any>;

  constructor(cfg: AppConfig['storage']) {
    this.bucket = cfg.bucket;
    this.clientPromise = import('@aws-sdk/client-s3').then(
      (m) => new m.S3Client({ region: cfg.region, endpoint: cfg.endpoint, forcePathStyle: cfg.forcePathStyle }),
    );
  }

  async uploadTarget(key: string, o: { contentType: string; sha256: string; size: number; ttlSeconds?: number }) {
    const [{ PutObjectCommand }, { getSignedUrl }, client] = await Promise.all([
      import('@aws-sdk/client-s3'),
      import('@aws-sdk/s3-request-presigner'),
      this.clientPromise,
    ]);
    const ttl = o.ttlSeconds ?? 900;
    const checksum = hexToBase64(o.sha256);
    // S3 rejects the PUT if the body does not match the declared SHA-256 or length.
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: o.contentType,
      ContentLength: o.size,
      ChecksumSHA256: checksum,
    });
    const url = await getSignedUrl(client, cmd, {
      expiresIn: ttl,
      signableHeaders: new Set(['content-type', 'x-amz-checksum-sha256']),
    });
    return {
      url,
      method: 'PUT' as const,
      headers: { 'Content-Type': o.contentType, 'x-amz-checksum-sha256': checksum },
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  async downloadUrl(key: string, o: { ttlSeconds?: number; fileName?: string; contentType?: string } = {}) {
    const [{ GetObjectCommand }, { getSignedUrl }, client] = await Promise.all([
      import('@aws-sdk/client-s3'),
      import('@aws-sdk/s3-request-presigner'),
      this.clientPromise,
    ]);
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: o.contentType,
        ResponseContentDisposition: o.fileName ? `inline; filename="${o.fileName.replace(/"/g, '')}"` : undefined,
      }),
      { expiresIn: o.ttlSeconds ?? 300 },
    );
  }

  async head(key: string): Promise<StoredObject | null> {
    const [{ HeadObjectCommand }, client] = await Promise.all([import('@aws-sdk/client-s3'), this.clientPromise]);
    try {
      const r = await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: 'ENABLED' }));
      return { size: Number(r.ContentLength ?? 0), sha256: r.ChecksumSHA256 ? base64ToHex(r.ChecksumSHA256) : null };
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return null;
      throw e;
    }
  }

  async put(key: string, body: Buffer, contentType: string) {
    const [{ PutObjectCommand }, client] = await Promise.all([import('@aws-sdk/client-s3'), this.clientPromise]);
    const sha = createHash('sha256').update(body).digest('base64');
    await client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ChecksumSHA256: sha }));
  }

  async get(key: string): Promise<Buffer> {
    const [{ GetObjectCommand }, client] = await Promise.all([import('@aws-sdk/client-s3'), this.clientPromise]);
    const r = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body.transformToByteArray());
  }

  async delete(key: string) {
    const [{ DeleteObjectCommand }, client] = await Promise.all([import('@aws-sdk/client-s3'), this.clientPromise]);
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Token carried in local-driver URLs: what may be done to which key, until when. */
interface LocalGrant {
  k: string;
  m: 'PUT' | 'GET';
  e: number;
  t?: string; // content type
  s?: string; // sha256 (PUT)
  n?: number; // size (PUT)
  f?: string; // file name (GET)
}

/**
 * Local-disk driver for development and tests. It mimics S3 presigned URLs
 * with HMAC-signed tokens served by `/v1/storage/local/:token`, so the client
 * flow is identical in every environment.
 */
export class LocalStorage implements StoragePort {
  readonly bucket = 'local';
  private readonly root: string;

  constructor(
    private readonly cfg: AppConfig['storage'],
    private readonly baseUrl: string,
  ) {
    this.root = resolve(cfg.localDir);
  }

  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + '/')) throw new Error('Invalid storage key');
    return p;
  }

  sign(grant: LocalGrant): string {
    const body = Buffer.from(JSON.stringify(grant)).toString('base64url');
    const mac = createHmac('sha256', this.cfg.signingSecret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  verify(token: string, method: 'PUT' | 'GET'): LocalGrant | null {
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expected = createHmac('sha256', this.cfg.signingSecret).update(body).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const g = JSON.parse(Buffer.from(body, 'base64url').toString()) as LocalGrant;
    if (g.m !== method || g.e < Date.now()) return null;
    return g;
  }

  async uploadTarget(key: string, o: { contentType: string; sha256: string; size: number; ttlSeconds?: number }) {
    const e = Date.now() + (o.ttlSeconds ?? 900) * 1000;
    const token = this.sign({ k: key, m: 'PUT', e, t: o.contentType, s: o.sha256, n: o.size });
    return {
      url: `${this.baseUrl}/v1/storage/local/${token}`,
      method: 'PUT' as const,
      headers: { 'Content-Type': o.contentType },
      expiresAt: new Date(e).toISOString(),
    };
  }

  async downloadUrl(key: string, o: { ttlSeconds?: number; fileName?: string; contentType?: string } = {}) {
    const token = this.sign({ k: key, m: 'GET', e: Date.now() + (o.ttlSeconds ?? 300) * 1000, t: o.contentType, f: o.fileName });
    return `${this.baseUrl}/v1/storage/local/${token}`;
  }

  /** Stream an upload to disk, enforcing the declared size and SHA-256 (like S3 checksums). */
  async receive(grant: LocalGrant, body: Readable): Promise<void> {
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.length;
      if (size > (grant.n ?? this.cfg.maxUploadBytes)) throw new Error('Body larger than declared size');
      hash.update(chunk);
      chunks.push(chunk);
    }
    if (size !== grant.n) throw new Error('Body size does not match declared size');
    if (hash.digest('hex') !== grant.s) throw new Error('Body SHA-256 does not match declared checksum');
    await this.put(grant.k, Buffer.concat(chunks), grant.t ?? 'application/octet-stream');
  }

  stream(key: string) {
    return createReadStream(this.path(key));
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const buf = await fs.readFile(this.path(key));
      return { size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async put(key: string, body: Buffer, _contentType?: string) {
    const p = this.path(key);
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.writeFile(p, body);
  }

  get(key: string) {
    return fs.readFile(this.path(key));
  }

  async delete(key: string) {
    await fs.rm(this.path(key), { force: true });
  }
}

export function createStorage(config: AppConfig): StoragePort {
  return config.storage.driver === 's3' ? new S3Storage(config.storage) : new LocalStorage(config.storage, config.publicBaseUrl);
}

/** Tenant-scoped object key; a tenant can never address another tenant's prefix. */
export function objectKey(tenantId: string, ownerType: string, ownerId: string, documentId: string, version = 1) {
  return `t/${tenantId}/${ownerType.toLowerCase()}/${ownerId}/${documentId}/${version}`;
}
