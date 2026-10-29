import { z } from 'zod';

const uuid = z.string().uuid();
const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'must be an ISO 8601 date-time');
const severity = z.enum(['MINOR', 'MAJOR', 'CRITICAL']);

export const findingInputSchema = z.object({
  /** Device-generated UUID v7 */
  id: uuid,
  violationCode: z.string().min(1).max(64),
  partyIds: z.array(uuid).max(10).default([]),
  remarks: z.string().max(4000).optional(),
  parameters: z.record(z.unknown()).optional(),
  override: z.object({ severity, reason: z.string().min(5).max(1000) }).optional(),
});

export const submitInspectionSchema = z.object({
  id: uuid,
  clientMutationId: uuid,
  processCode: z.string().min(1).max(64),
  inspectableId: uuid,
  kind: z
    .enum(['SCHEDULED', 'RANDOM', 'SERVICE', 'FOLLOW_UP', 'MANAGEMENT_ORDER', 'COMPLAINT'])
    .default('RANDOM'),
  taskId: uuid.optional(),
  deviceId: uuid.optional(),
  startedAt: isoDate.optional(),
  completedAt: isoDate,
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  generalRemarks: z.string().max(4000).optional(),
  siteStatus: z.string().max(500).optional(),
  findings: z.array(findingInputSchema).max(100).default([]),
  /** Earlier open findings the inspector verified as complied with. */
  resolvedFindingIds: z.array(uuid).max(200).default([]),
  checklist: z.array(z.object({ itemId: uuid, value: z.unknown() })).max(500).default([]),
  signature: z
    .object({
      method: z.enum(['CANVAS', 'UAE_PASS', 'UPLOAD', 'REFUSED']),
      signerName: z.string().min(1).max(200),
      signerRole: z.string().max(100).optional(),
      signedPayloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
      signatureSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    })
    .optional(),
});
export type SubmitInspection = z.infer<typeof submitInspectionSchema>;

export const evaluateSchema = z.object({
  processCode: z.string(),
  inspectableId: uuid,
  inspectionDate: isoDate.optional(),
  findings: z.array(z.object({ violationCode: z.string(), partyIds: z.array(uuid).default([]) })).max(100),
});

export const decideSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'MORE_INFO']),
  comment: z.string().max(2000).optional(),
  /** Decisions on pending severity overrides; default = approve all. */
  overrides: z.array(z.object({ findingId: uuid, approve: z.boolean() })).default([]),
});

export const respondSchema = z.object({ remarks: z.string().min(1).max(4000) });

export const clearSignatureSchema = z.object({ reason: z.string().min(5).max(1000) });
