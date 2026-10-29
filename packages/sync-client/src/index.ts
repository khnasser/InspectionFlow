import {
  evaluateInspection,
  InspectionResult,
  PriorOccurrence,
  uuidv7,
  ViolationRule,
} from '@inspectionflow/engine';

/** Minimal async key-value store (SQLite on the device, memory in tests). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>();
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.map.set(k, v);
  }
  async delete(k: string) {
    this.map.delete(k);
  }
  async keys(prefix: string) {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

export interface FindingDraft {
  id: string;
  violationCode: string;
  partyIds: string[];
  remarks?: string;
  parameters?: Record<string, unknown>;
  override?: { severity: 'MINOR' | 'MAJOR' | 'CRITICAL'; reason: string };
}

export interface InspectionDraft {
  processCode: string;
  inspectableId: string;
  kind: 'SCHEDULED' | 'RANDOM' | 'FOLLOW_UP' | 'MANAGEMENT_ORDER' | 'COMPLAINT' | 'SERVICE';
  taskId?: string;
  startedAt?: string;
  completedAt: string;
  latitude?: number;
  longitude?: number;
  generalRemarks?: string;
  findings: FindingDraft[];
  resolvedFindingIds: string[];
  checklist: Array<{ itemId: string; value: unknown }>;
  signature?: { method: 'CANVAS' | 'REFUSED'; signerName: string; signerRole?: string; signatureSha256?: string };
}

export interface QueuedMutation {
  clientMutationId: string;
  type: 'inspection.submit';
  payload: Record<string, unknown> & { id: string };
  queuedAt: string;
  attempts: number;
  lastError?: string;
  state: 'PENDING' | 'FAILED';
}

export interface PushResult {
  clientMutationId: string;
  status: 'APPLIED' | 'REPLAYED' | 'REJECTED';
  result?: any;
  error?: { status: number; message: unknown };
}

/** Transport to the API; the app supplies fetch-based functions. */
export interface SyncTransport {
  push(batch: { batchId: string; deviceId: string; platform: 'IOS' | 'ANDROID'; mutations: Array<Pick<QueuedMutation, 'clientMutationId' | 'type' | 'payload'>> }): Promise<{ results: PushResult[] }>;
  pull(): Promise<WorkPackage>;
  bundle(): Promise<ConfigBundle>;
}

export interface WorkPackage {
  serverTime: string;
  tasks: any[];
  inspectables: any[];
  openFindings: any[];
  occurrences: PriorOccurrence[];
}

export interface ConfigBundle {
  tenant: { id: string; timeZone: string; weekendDays: number[]; defaultLocale: string };
  processes: Array<{ code: string; name_i18n: Record<string, string>; violations: Array<{ code: string; description_i18n: Record<string, string>; rule: ViolationRule | null }>; checklists: any[]; thresholds: any[] }>;
  generatedAt: string;
}

export type Sha256 = (text: string) => Promise<string>;

const OUTBOX = 'outbox:';
const K_PACKAGE = 'package';
const K_BUNDLE = 'bundle';
const K_RESULTS = 'results:';

/** Stable JSON (sorted keys) used for the signed-payload hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/**
 * Offline-first client: every completed inspection goes to a persistent outbox
 * first, then sync pushes it. Mutations leave the outbox only when the server
 * confirms (APPLIED or REPLAYED). 4xx rejections are parked as FAILED for the
 * inspector to fix; network and 5xx errors are retried on the next sync.
 */
export class SyncClient {
  constructor(
    private readonly store: KeyValueStore,
    private readonly transport: SyncTransport,
    private readonly deviceId: string,
    private readonly platform: 'IOS' | 'ANDROID',
    private readonly sha256: Sha256,
  ) {}

  /** Queue a completed inspection; returns the ids the server will use. */
  async enqueueInspection(draft: InspectionDraft): Promise<{ inspectionId: string; clientMutationId: string }> {
    const inspectionId = uuidv7();
    const clientMutationId = uuidv7();
    const signedContent = canonicalJson({ ...draft, signature: undefined, id: inspectionId });
    const payload: QueuedMutation['payload'] = {
      ...draft,
      id: inspectionId,
      clientMutationId,
      deviceId: this.deviceId,
      signature: draft.signature
        ? { ...draft.signature, signedPayloadSha256: await this.sha256(signedContent) }
        : undefined,
    };
    const m: QueuedMutation = {
      clientMutationId,
      type: 'inspection.submit',
      payload,
      queuedAt: new Date().toISOString(),
      attempts: 0,
      state: 'PENDING',
    };
    // Keys sort by UUID v7 => submission order is preserved.
    await this.store.set(`${OUTBOX}${clientMutationId}`, JSON.stringify(m));
    return { inspectionId, clientMutationId };
  }

  async outbox(): Promise<QueuedMutation[]> {
    const keys = await this.store.keys(OUTBOX);
    const items = await Promise.all(keys.map(async (k) => JSON.parse((await this.store.get(k))!) as QueuedMutation));
    return items;
  }

  async pendingCount(): Promise<number> {
    return (await this.outbox()).filter((m) => m.state === 'PENDING').length;
  }

  /** Server outcome of a synced inspection, when known. */
  async result(clientMutationId: string): Promise<any | null> {
    const v = await this.store.get(`${K_RESULTS}${clientMutationId}`);
    return v ? JSON.parse(v) : null;
  }

  /** Retry a FAILED mutation after the inspector corrected it. */
  async requeue(clientMutationId: string, patch: Partial<QueuedMutation['payload']> = {}) {
    const raw = await this.store.get(`${OUTBOX}${clientMutationId}`);
    if (!raw) return;
    const m = JSON.parse(raw) as QueuedMutation;
    m.payload = { ...m.payload, ...patch };
    m.state = 'PENDING';
    m.lastError = undefined;
    await this.store.set(`${OUTBOX}${clientMutationId}`, JSON.stringify(m));
  }

  async discard(clientMutationId: string) {
    await this.store.delete(`${OUTBOX}${clientMutationId}`);
  }

  /** Push the outbox, then refresh the work package and configuration. */
  async sync(opts: { batchSize?: number; refreshBundle?: boolean } = {}): Promise<{ pushed: number; failed: number; pending: number; online: boolean }> {
    const batchSize = opts.batchSize ?? 50;
    let pushed = 0;
    let failed = 0;
    const pending = (await this.outbox()).filter((m) => m.state === 'PENDING');
    try {
      for (let i = 0; i < pending.length; i += batchSize) {
        const chunk = pending.slice(i, i + batchSize);
        const res = await this.transport.push({
          batchId: uuidv7(),
          deviceId: this.deviceId,
          platform: this.platform,
          mutations: chunk.map(({ clientMutationId, type, payload }) => ({ clientMutationId, type, payload })),
        });
        for (const m of chunk) {
          const r = res.results.find((x) => x.clientMutationId === m.clientMutationId);
          if (r && (r.status === 'APPLIED' || r.status === 'REPLAYED')) {
            await this.store.set(`${K_RESULTS}${m.clientMutationId}`, JSON.stringify(r.result ?? null));
            await this.store.delete(`${OUTBOX}${m.clientMutationId}`);
            pushed++;
          } else if (r && r.status === 'REJECTED' && r.error && r.error.status >= 400 && r.error.status < 500) {
            m.state = 'FAILED';
            m.attempts++;
            m.lastError = JSON.stringify(r.error.message);
            await this.store.set(`${OUTBOX}${m.clientMutationId}`, JSON.stringify(m));
            failed++;
          } else {
            m.attempts++;
            m.lastError = r?.error ? JSON.stringify(r.error.message) : 'No result';
            await this.store.set(`${OUTBOX}${m.clientMutationId}`, JSON.stringify(m));
          }
        }
      }
      const pkg = await this.transport.pull();
      await this.store.set(K_PACKAGE, JSON.stringify(pkg));
      if (opts.refreshBundle || !(await this.store.get(K_BUNDLE))) {
        await this.store.set(K_BUNDLE, JSON.stringify(await this.transport.bundle()));
      }
      return { pushed, failed, pending: await this.pendingCount(), online: true };
    } catch {
      // Network down or server unreachable: everything stays queued.
      return { pushed, failed, pending: await this.pendingCount(), online: false };
    }
  }

  async workPackage(): Promise<WorkPackage | null> {
    const v = await this.store.get(K_PACKAGE);
    return v ? JSON.parse(v) : null;
  }

  async configBundle(): Promise<ConfigBundle | null> {
    const v = await this.store.get(K_BUNDLE);
    return v ? JSON.parse(v) : null;
  }

  /**
   * Provisional engine result, fully offline: cached rules + cached occurrence
   * history + findings from inspections still waiting in the outbox. The server
   * recalculates on submit; the inspector sees any difference afterwards.
   */
  async provisional(draft: Pick<InspectionDraft, 'processCode' | 'inspectableId' | 'findings' | 'completedAt'>): Promise<InspectionResult> {
    const bundle = await this.configBundle();
    const pkg = await this.workPackage();
    if (!bundle) throw new Error('No configuration cached yet: sync once while online');
    const process = bundle.processes.find((p) => p.code === draft.processCode);
    if (!process) throw new Error(`Unknown process ${draft.processCode}`);
    const rules: Record<string, ViolationRule> = {};
    for (const v of process.violations) if (v.rule) rules[v.code] = v.rule;

    const openCodes = new Set(
      (pkg?.openFindings ?? []).filter((f) => f.inspectable_id === draft.inspectableId).map((f) => f.violation_code),
    );
    const queued = (await this.outbox()).filter((m) => m.state === 'PENDING' && m.payload.processCode === draft.processCode);
    const queuedOccurrences: PriorOccurrence[] = queued.flatMap((m) =>
      ((m.payload.findings as FindingDraft[]) ?? []).map((f) => ({
        violationCode: f.violationCode,
        scopeType: 'INSPECTABLE' as const,
        inspectableId: m.payload.inspectableId as string,
        partyId: null,
        occurredAt: m.payload.completedAt as string,
        isCounted: true,
      })),
    );

    return evaluateInspection({
      findings: draft.findings.map((f) => ({
        violationCode: f.violationCode,
        inspectableId: draft.inspectableId,
        partyIds: f.partyIds,
        carriedForward: openCodes.has(f.violationCode),
      })),
      rules,
      prior: [...(pkg?.occurrences ?? []), ...queuedOccurrences],
      thresholds: process.thresholds ?? [],
      ctx: { inspectionDate: draft.completedAt, timeZone: bundle.tenant.timeZone, weekendDays: bundle.tenant.weekendDays },
    });
  }
}
