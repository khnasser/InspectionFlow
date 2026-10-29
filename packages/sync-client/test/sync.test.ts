import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { ViolationRule } from '@inspectionflow/engine';
import { AttachmentDraft, ConfigBundle, HttpError, InspectionDraft, MemoryStore, PushResult, SyncClient, SyncTransport, WorkPackage } from '../src';

const sha = async (t: string) => createHash('sha256').update(t).digest('hex');

const rule: ViolationRule = {
  violationCode: 'CS-01',
  repetitionStrategy: 'INSPECTABLE',
  repeatWindowDays: null,
  resetPolicy: 'NONE',
  fineMode: 'LADDER',
  followUpDays: { MINOR: 7, MAJOR: 3, CRITICAL: 0 },
  calendarDays: true,
  severityOverride: 'WITH_APPROVAL',
  ladder: [
    { fromOccurrence: 1, toOccurrence: 1, actionCode: 'FIR', severity: 'MINOR', fineAmount: 0, requiresManagerReview: false, requiresCommitteeReview: false },
    { fromOccurrence: 2, toOccurrence: null, actionCode: 'WARNING', severity: 'MAJOR', fineAmount: 0, requiresManagerReview: true, requiresCommitteeReview: false },
  ],
};

const bundle: ConfigBundle = {
  tenant: { id: 't', timeZone: 'Asia/Dubai', weekendDays: [6, 7], defaultLocale: 'ar-AE' },
  processes: [{ code: 'CS', name_i18n: {}, violations: [{ code: 'CS-01', description_i18n: {}, rule }], checklists: [], thresholds: [] }],
  generatedAt: '2027-01-01T00:00:00Z',
};
const pkg: WorkPackage = { serverTime: '2027-01-01T00:00:00Z', tasks: [{ id: 'task-1' }], inspectables: [], openFindings: [], occurrences: [] };

/** Fake server: can be offline, can reject by process code, remembers applied ids. */
class FakeTransport implements SyncTransport {
  uploads?: SyncTransport['uploads'];
  online = true;
  applied = new Set<string>();
  pushes = 0;
  async push(batch: Parameters<SyncTransport['push']>[0]) {
    if (!this.online) throw new Error('network down');
    this.pushes++;
    const results: PushResult[] = batch.mutations.map((m) => {
      if (m.payload.processCode === 'BAD') return { clientMutationId: m.clientMutationId, status: 'REJECTED', error: { status: 404, message: 'Unknown process' } };
      if (m.payload.processCode === 'FLAKY') return { clientMutationId: m.clientMutationId, status: 'REJECTED', error: { status: 500, message: 'oops' } };
      const replay = this.applied.has(m.clientMutationId);
      this.applied.add(m.clientMutationId);
      return { clientMutationId: m.clientMutationId, status: replay ? 'REPLAYED' : 'APPLIED', result: { inspectionId: m.payload.id, status: 'APPROVED' } };
    });
    return { results };
  }
  async pull() {
    if (!this.online) throw new Error('network down');
    return pkg;
  }
  async bundle() {
    return bundle;
  }
}

const draft = (over: Partial<InspectionDraft> = {}): InspectionDraft => ({
  processCode: 'CS',
  inspectableId: 'site-1',
  kind: 'SCHEDULED',
  completedAt: '2027-03-10T09:00:00+04:00',
  findings: [{ id: 'f1', violationCode: 'CS-01', partyIds: [] }],
  resolvedFindingIds: [],
  checklist: [],
  ...over,
});

describe('SyncClient', () => {
  it('queues offline, keeps the queue while the network is down, then pushes in order', async () => {
    const store = new MemoryStore();
    const t = new FakeTransport();
    const c = new SyncClient(store, t, 'device-1', 'ANDROID', sha);
    t.online = false;
    const a = await c.enqueueInspection(draft());
    const b = await c.enqueueInspection(draft({ inspectableId: 'site-2' }));
    expect(await c.sync()).toMatchObject({ online: false, pending: 2, pushed: 0 });

    t.online = true;
    const r = await c.sync();
    expect(r).toMatchObject({ online: true, pushed: 2, pending: 0 });
    expect((await c.result(a.clientMutationId)).inspectionId).toBe(a.inspectionId);
    expect(await c.result(b.clientMutationId)).not.toBeNull();
    expect(await c.workPackage()).toEqual(pkg);
    expect(await c.configBundle()).toEqual(bundle);
  });

  it('parks 4xx rejections as FAILED, retries 5xx, and can requeue after a fix', async () => {
    const c = new SyncClient(new MemoryStore(), new FakeTransport(), 'd', 'IOS', sha);
    const bad = await c.enqueueInspection(draft({ processCode: 'BAD' }));
    const flaky = await c.enqueueInspection(draft({ processCode: 'FLAKY' }));
    const r = await c.sync();
    expect(r).toMatchObject({ failed: 1, pushed: 0, pending: 1 });
    const box = await c.outbox();
    expect(box.find((m) => m.clientMutationId === bad.clientMutationId)!.state).toBe('FAILED');
    expect(box.find((m) => m.clientMutationId === flaky.clientMutationId)!).toMatchObject({ state: 'PENDING', attempts: 1 });

    await c.requeue(bad.clientMutationId, { processCode: 'CS' });
    await c.discard(flaky.clientMutationId);
    expect(await c.sync()).toMatchObject({ pushed: 1, pending: 0 });
  });

  it('a retry after a lost response is harmless (server replays)', async () => {
    const t = new FakeTransport();
    const store = new MemoryStore();
    const c = new SyncClient(store, t, 'd', 'ANDROID', sha);
    const q = await c.enqueueInspection(draft());
    // Simulate: server applied it but the response never arrived.
    t.applied.add(q.clientMutationId);
    expect(await c.sync()).toMatchObject({ pushed: 1, pending: 0 });
  });

  it('hashes the signed content into the payload', async () => {
    const c = new SyncClient(new MemoryStore(), new FakeTransport(), 'd', 'ANDROID', sha);
    await c.enqueueInspection(draft({ signature: { method: 'CANVAS', signerName: 'Site engineer' } }));
    const [m] = await c.outbox();
    expect((m.payload.signature as any).signedPayloadSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('provisional result works offline and counts inspections still in the outbox', async () => {
    const t = new FakeTransport();
    const c = new SyncClient(new MemoryStore(), t, 'd', 'ANDROID', sha);
    await c.sync(); // caches bundle + package
    t.online = false;
    const first = await c.provisional(draft());
    expect(first.findings[0]).toMatchObject({ occurrence: 1, actionCode: 'FIR', resolveBy: '2027-03-17' });
    await c.enqueueInspection(draft({ completedAt: '2027-03-01T09:00:00+04:00' }));
    const second = await c.provisional(draft());
    expect(second.findings[0]).toMatchObject({ occurrence: 2, actionCode: 'WARNING' });
    expect(second.review).toBe('MANAGER');
  });

  it('provisional evaluation needs a cached configuration', async () => {
    const c = new SyncClient(new MemoryStore(), new FakeTransport(), 'd', 'ANDROID', sha);
    await expect(c.provisional(draft())).rejects.toThrow(/sync once/);
  });
});

describe('evidence attachments', () => {
  class FakeUploads {
    online = true;
    objects = new Map<string, string>();
    puts = 0;
    async initiate(meta: { id: string; sha256: string; mimeType: string }) {
      if (!this.online) throw new Error('network down');
      if (meta.mimeType === 'application/x-msdownload') throw new HttpError(400, 'unsupported file type');
      if (this.objects.get(meta.id) === 'AVAILABLE') return { status: 'AVAILABLE', upload: null };
      this.objects.set(meta.id, 'PENDING');
      return { status: 'PENDING', upload: { url: `https://s3/${meta.id}`, method: 'PUT' as const, headers: {} } };
    }
    async put(_t: unknown, localUri: string) {
      if (!this.online) throw new Error('network down');
      this.puts++;
      if (localUri.includes('corrupt')) return;
    }
    async complete(id: string) {
      const corrupt = id.startsWith('corrupt');
      this.objects.set(id, corrupt ? 'REJECTED' : 'AVAILABLE');
      return { status: corrupt ? 'REJECTED' : 'AVAILABLE' };
    }
  }

  const photo = (id: string, localUri = `file:///photos/${id}.jpg`): AttachmentDraft => ({
    id,
    ownerType: 'FINDING',
    ownerId: 'finding-1',
    localUri,
    mimeType: 'image/jpeg',
    sizeBytes: 1000,
    sha256: 'a'.repeat(64),
  });

  it('keeps photos queued while offline and uploads them later, once', async () => {
    const t = new FakeTransport();
    const uploads = new FakeUploads();
    t.uploads = uploads;
    const c = new SyncClient(new MemoryStore(), t, 'device-1', 'ANDROID', sha);
    await c.addAttachment(photo('p1'));
    await c.addAttachment(photo('p2'));

    uploads.online = false;
    expect(await c.uploadAttachments()).toMatchObject({ uploaded: [], online: false, pending: 2 });

    uploads.online = true;
    const r = await c.uploadAttachments();
    expect(r).toMatchObject({ failed: 0, pending: 0, online: true });
    expect(r.uploaded).toEqual(['file:///photos/p1.jpg', 'file:///photos/p2.jpg']);
    expect(await c.attachments()).toHaveLength(0);

    // A retry after a lost response does not upload twice.
    await c.addAttachment(photo('p1'));
    expect((await c.uploadAttachments()).uploaded).toHaveLength(1);
    expect(uploads.puts).toBe(2);
  });

  it('parks rejected files for the inspector instead of retrying forever', async () => {
    const t = new FakeTransport();
    t.uploads = new FakeUploads();
    const c = new SyncClient(new MemoryStore(), t, 'device-1', 'IOS', sha);
    await c.addAttachment({ ...photo('bad'), mimeType: 'application/x-msdownload' });
    await c.addAttachment(photo('corrupt-1', 'file:///photos/corrupt.jpg'));
    const r = await c.uploadAttachments();
    expect(r).toMatchObject({ failed: 2, pending: 0 });
    const parked = await c.attachments();
    expect(parked.map((a) => a.state)).toEqual(['FAILED', 'FAILED']);
    expect(parked.find((a) => a.id === 'bad')!.lastError).toContain('400');
  });

  it('lets the app choose the inspection id so photos can reference it before queueing', async () => {
    const c = new SyncClient(new MemoryStore(), new FakeTransport(), 'device-1', 'IOS', sha);
    const { inspectionId } = await c.enqueueInspection(draft({ id: 'pre-generated-id' }));
    expect(inspectionId).toBe('pre-generated-id');
  });
});
