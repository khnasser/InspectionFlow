/**
 * Types for the InspectionFlow violation engine.
 *
 * The engine is pure and deterministic: the same inputs always give the same
 * outputs. It runs on the mobile device (provisional result, offline) and on
 * the server (authoritative result at submit time).
 */

export type Severity = 'MINOR' | 'MAJOR' | 'CRITICAL';

export type RepetitionStrategy =
  | 'INSPECTABLE'
  | 'PARTY'
  | 'INSPECTABLE_AND_PARTY'
  | 'INSPECTABLE_PER_YEAR'
  | 'PARTY_PER_YEAR'
  | 'INSPECTABLE_AND_PARTY_PER_YEAR'
  | 'NONE';

export type ScopeType = 'INSPECTABLE' | 'PARTY' | 'INSPECTABLE_AND_PARTY';

export type ResetPolicy = 'NONE' | 'CALENDAR_YEAR' | 'ROLLING_WINDOW';

export type FineMode = 'LADDER' | 'MULTIPLIER';

export type ReviewLevel = 'NONE' | 'MANAGER' | 'COMMITTEE';

export type InspectionCategory = 'NO_FINDINGS' | 'MINOR' | 'WARNING' | 'PENALTY_CRITICAL';

/** One row of the occurrence ladder: occurrence range -> consequence. */
export interface LadderStep {
  fromOccurrence: number;
  /** null = this occurrence and above */
  toOccurrence: number | null;
  actionCode: string;
  severity: Severity;
  /** Fine for LADDER mode (published fine tables). */
  fineAmount?: number | null;
  requiresManagerReview: boolean;
  requiresCommitteeReview: boolean;
  suspensionDays?: number | null;
}

/** Per-violation rule configuration (violation_rules + violation_action_ladder). */
export interface ViolationRule {
  violationCode: string;
  repetitionStrategy: RepetitionStrategy;
  /** Only count prior occurrences within this many days; null = unlimited. */
  repeatWindowDays: number | null;
  resetPolicy: ResetPolicy;
  fineMode: FineMode;
  baseFine?: number | null;
  fineMultiplier?: number | null;
  fineCap?: number | null;
  /** Days allowed to resolve, per severity. 0 = immediately (same day). */
  followUpDays: Record<Severity, number>;
  /** true = calendar days; false = working days (tenant weekend skipped). */
  calendarDays: boolean;
  ladder: LadderStep[];
  severityOverride: 'NOT_ALLOWED' | 'WITH_APPROVAL' | 'ALLOWED';
}

/** A counted occurrence from the ledger (violation_occurrences). */
export interface PriorOccurrence {
  violationCode: string;
  scopeType: ScopeType;
  inspectableId?: string | null;
  partyId?: string | null;
  /** ISO 8601 timestamp */
  occurredAt: string;
  isCounted: boolean;
}

export interface FindingInput {
  violationCode: string;
  inspectableId: string;
  /** Responsible / penalised parties for this finding (one or more). */
  partyIds: string[];
  /** true when the finding continues an unresolved finding from an earlier cycle. */
  carriedForward?: boolean;
}

export interface EvaluationContext {
  /** ISO 8601 timestamp of the inspection. */
  inspectionDate: string;
  /** IANA time zone of the tenant, e.g. Asia/Dubai. */
  timeZone: string;
  /** ISO day-of-week numbers that are weekend days (1 = Monday ... 7 = Sunday). */
  weekendDays: number[];
}

/** One scope key the occurrence was counted against. */
export interface ScopeKey {
  scopeType: ScopeType;
  inspectableId: string | null;
  partyId: string | null;
  /** 'ALL' or the calendar year, e.g. '2027' */
  periodKey: string;
}

export interface FindingResult {
  violationCode: string;
  /** Occurrence number used to pick the ladder step (max across scope keys). */
  occurrence: number;
  /** Per scope key: the occurrence number that a new ledger row would get. */
  scopeOccurrences: Array<ScopeKey & { occurrenceNo: number }>;
  /** false for carried-forward findings: they were counted in an earlier cycle. */
  recordOccurrence: boolean;
  actionCode: string;
  severity: Severity;
  fine: number;
  /** ISO date (yyyy-mm-dd) in the tenant time zone. */
  resolveBy: string;
  review: ReviewLevel;
  suspensionDays: number | null;
  warnings: string[];
}

export interface ApprovalThreshold {
  minAmount: number;
  maxAmount: number | null;
  /** Role codes in order, e.g. ['SECTION_MANAGER','DIRECTOR','CEO'] */
  approvalChain: string[];
}

export interface InspectionResult {
  category: InspectionCategory;
  totalFine: number;
  /** Earliest resolveBy across findings, or null when no findings. */
  followUpDate: string | null;
  review: ReviewLevel;
  approvalChain: string[];
  findings: FindingResult[];
}
