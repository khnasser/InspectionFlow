import {
  addCalendarDays,
  addWorkingDays,
  daysBetween,
  localDate,
  localYear,
} from './dates';
import {
  ApprovalThreshold,
  EvaluationContext,
  FindingInput,
  FindingResult,
  InspectionCategory,
  InspectionResult,
  LadderStep,
  PriorOccurrence,
  ReviewLevel,
  ScopeKey,
  ScopeType,
  Severity,
  ViolationRule,
} from './types';

export class EngineConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineConfigError';
  }
}

const SEVERITY_RANK: Record<Severity, number> = { MINOR: 1, MAJOR: 2, CRITICAL: 3 };
const REVIEW_RANK: Record<ReviewLevel, number> = { NONE: 0, MANAGER: 1, COMMITTEE: 2 };

/** Round to 2 decimals (fils), half away from zero. */
export function roundMoney(value: number): number {
  // Exponent-string shifting avoids binary artefacts such as 1.005 * 100 = 100.49999...
  const abs = Math.abs(value);
  const rounded = Number(`${Math.round(Number(`${abs}e2`))}e-2`);
  return value < 0 ? -rounded : rounded;
}

function isPerYear(strategy: ViolationRule['repetitionStrategy']): boolean {
  return strategy.endsWith('_PER_YEAR');
}

function baseScope(strategy: ViolationRule['repetitionStrategy']): ScopeType | null {
  switch (strategy) {
    case 'INSPECTABLE':
    case 'INSPECTABLE_PER_YEAR':
      return 'INSPECTABLE';
    case 'PARTY':
    case 'PARTY_PER_YEAR':
      return 'PARTY';
    case 'INSPECTABLE_AND_PARTY':
    case 'INSPECTABLE_AND_PARTY_PER_YEAR':
      return 'INSPECTABLE_AND_PARTY';
    case 'NONE':
      return null;
    default:
      throw new EngineConfigError(`Unknown repetition strategy: ${String(strategy)}`);
  }
}

/** The scope keys a finding is counted against under the rule's strategy. */
export function scopeKeysFor(
  finding: FindingInput,
  rule: ViolationRule,
  ctx: EvaluationContext,
): { keys: ScopeKey[]; warnings: string[] } {
  const warnings: string[] = [];
  const scope = baseScope(rule.repetitionStrategy);
  if (scope === null) return { keys: [], warnings };

  const yearly = isPerYear(rule.repetitionStrategy) || rule.resetPolicy === 'CALENDAR_YEAR';
  const periodKey = yearly ? localYear(ctx.inspectionDate, ctx.timeZone) : 'ALL';
  const parties = Array.from(new Set(finding.partyIds));

  if (scope === 'INSPECTABLE') {
    return {
      keys: [{ scopeType: scope, inspectableId: finding.inspectableId, partyId: null, periodKey }],
      warnings,
    };
  }
  if (parties.length === 0) {
    warnings.push('NO_PARTY_FOR_PARTY_STRATEGY');
    return { keys: [], warnings };
  }
  return {
    keys: parties.map((partyId) => ({
      scopeType: scope,
      inspectableId: scope === 'INSPECTABLE_AND_PARTY' ? finding.inspectableId : null,
      partyId,
      periodKey,
    })),
    warnings,
  };
}

function matchesKey(
  o: PriorOccurrence,
  code: string,
  key: ScopeKey,
  rule: ViolationRule,
  ctx: EvaluationContext,
): boolean {
  if (!o.isCounted || o.violationCode !== code || o.scopeType !== key.scopeType) return false;
  if ((o.inspectableId ?? null) !== key.inspectableId) return false;
  if ((o.partyId ?? null) !== key.partyId) return false;
  // Only occurrences strictly before this inspection count as "prior".
  if (new Date(o.occurredAt).getTime() >= new Date(ctx.inspectionDate).getTime()) return false;
  if (key.periodKey !== 'ALL' && localYear(o.occurredAt, ctx.timeZone) !== key.periodKey) return false;
  if (rule.repeatWindowDays !== null && rule.repeatWindowDays !== undefined) {
    if (daysBetween(o.occurredAt, ctx.inspectionDate) > rule.repeatWindowDays) return false;
  }
  return true;
}

/** Pick the ladder step for an occurrence number. */
export function ladderStepFor(ladder: LadderStep[], occurrence: number): LadderStep {
  if (ladder.length === 0) throw new EngineConfigError('Violation rule has an empty ladder');
  const exact = ladder.find(
    (s) => s.fromOccurrence <= occurrence && (s.toOccurrence === null || occurrence <= s.toOccurrence),
  );
  if (exact) return exact;
  // Past the last bounded step: use the highest step that starts at or below n.
  const below = ladder
    .filter((s) => s.fromOccurrence <= occurrence)
    .sort((a, b) => b.fromOccurrence - a.fromOccurrence);
  if (below.length > 0) return below[0];
  throw new EngineConfigError(`No ladder step covers occurrence ${occurrence}`);
}

function computeFine(rule: ViolationRule, step: LadderStep, occurrence: number): number {
  if (rule.fineMode === 'MULTIPLIER') {
    const base = rule.baseFine ?? 0;
    const multiplier = rule.fineMultiplier ?? 1;
    let fine = base * Math.pow(multiplier, occurrence - 1);
    if (rule.fineCap !== null && rule.fineCap !== undefined) fine = Math.min(fine, rule.fineCap);
    return roundMoney(fine);
  }
  return roundMoney(step.fineAmount ?? 0);
}

function reviewFor(step: LadderStep): ReviewLevel {
  if (step.requiresCommitteeReview) return 'COMMITTEE';
  if (step.requiresManagerReview) return 'MANAGER';
  return 'NONE';
}

/**
 * Evaluate one finding: occurrence -> ladder step -> severity, action, fine,
 * follow-up date and review route.
 */
export function evaluateFinding(
  finding: FindingInput,
  rule: ViolationRule,
  prior: PriorOccurrence[],
  ctx: EvaluationContext,
): FindingResult {
  if (rule.violationCode !== finding.violationCode) {
    throw new EngineConfigError(
      `Rule ${rule.violationCode} does not belong to finding ${finding.violationCode}`,
    );
  }
  const { keys, warnings } = scopeKeysFor(finding, rule, ctx);

  const scopeOccurrences = keys.map((key) => {
    const count = prior.filter((o) => matchesKey(o, finding.violationCode, key, rule, ctx)).length;
    // A carried-forward finding was already counted when first raised.
    const occurrenceNo = finding.carriedForward ? Math.max(count, 1) : count + 1;
    return { ...key, occurrenceNo };
  });

  const occurrence = scopeOccurrences.length
    ? Math.max(...scopeOccurrences.map((s) => s.occurrenceNo))
    : 1;

  const step = ladderStepFor(rule.ladder, occurrence);
  const today = localDate(ctx.inspectionDate, ctx.timeZone);
  const days = rule.followUpDays[step.severity];
  if (days === undefined || days < 0) {
    throw new EngineConfigError(`No follow-up days configured for ${step.severity}`);
  }
  const resolveBy = rule.calendarDays
    ? addCalendarDays(today, days)
    : addWorkingDays(today, days, ctx.weekendDays);

  return {
    violationCode: finding.violationCode,
    occurrence,
    scopeOccurrences,
    recordOccurrence: !finding.carriedForward && scopeOccurrences.length > 0,
    actionCode: step.actionCode,
    severity: step.severity,
    fine: computeFine(rule, step, occurrence),
    resolveBy,
    review: reviewFor(step),
    suspensionDays: step.suspensionDays ?? null,
    warnings,
  };
}

/** Category from the highest severity among findings (BRS: critical = penalty, major = final warning). */
export function categoryFor(findings: FindingResult[]): InspectionCategory {
  if (findings.length === 0) return 'NO_FINDINGS';
  const max = Math.max(...findings.map((f) => SEVERITY_RANK[f.severity]));
  if (max === 3) return 'PENALTY_CRITICAL';
  if (max === 2) return 'WARNING';
  return 'MINOR';
}

/** Approval chain by total fine; falls back to defaults per review level. */
export function approvalChainFor(
  review: ReviewLevel,
  totalFine: number,
  thresholds: ApprovalThreshold[],
): string[] {
  if (review === 'NONE') return [];
  const match = thresholds.find(
    (t) => totalFine >= t.minAmount && (t.maxAmount === null || totalFine <= t.maxAmount),
  );
  if (match) return match.approvalChain;
  return review === 'COMMITTEE' ? ['SECTION_MANAGER', 'COMMITTEE'] : ['SECTION_MANAGER'];
}

export interface InspectionEvaluationInput {
  findings: FindingInput[];
  rules: Record<string, ViolationRule>;
  prior: PriorOccurrence[];
  thresholds: ApprovalThreshold[];
  ctx: EvaluationContext;
}

/** Evaluate a whole inspection: per-finding results plus inspection-level rules. */
export function evaluateInspection(input: InspectionEvaluationInput): InspectionResult {
  const codes = input.findings.map((f) => f.violationCode);
  const duplicate = codes.find((c, i) => codes.indexOf(c) !== i);
  if (duplicate) {
    // BRS rule: a violation code appears at most once per inspection.
    throw new EngineConfigError(`Violation ${duplicate} appears more than once in the inspection`);
  }

  const findings = input.findings.map((f) => {
    const rule = input.rules[f.violationCode];
    if (!rule) throw new EngineConfigError(`No rule configured for violation ${f.violationCode}`);
    return evaluateFinding(f, rule, input.prior, input.ctx);
  });

  const totalFine = roundMoney(findings.reduce((sum, f) => sum + f.fine, 0));
  const review = findings.reduce<ReviewLevel>(
    (acc, f) => (REVIEW_RANK[f.review] > REVIEW_RANK[acc] ? f.review : acc),
    'NONE',
  );
  const followUpDate = findings.length
    ? findings.map((f) => f.resolveBy).sort()[0]
    : null;

  return {
    category: categoryFor(findings),
    totalFine,
    followUpDate,
    review,
    approvalChain: approvalChainFor(review, totalFine, input.thresholds),
    findings,
  };
}

/**
 * Change to the occurrence counter when a manager APPROVES a severity override
 * (construction-safety rules): demotion -1, escalation +1, otherwise 0.
 * A rejected override never changes the counter.
 */
export function overrideCounterDelta(from: Severity, to: Severity, approved: boolean): number {
  if (!approved) return 0;
  const diff = SEVERITY_RANK[to] - SEVERITY_RANK[from];
  return diff === 0 ? 0 : diff > 0 ? 1 : -1;
}

/** Whether an inspector may override a calculated severity, and whether approval is needed. */
export function overridePolicy(rule: ViolationRule): { allowed: boolean; needsApproval: boolean } {
  switch (rule.severityOverride) {
    case 'NOT_ALLOWED':
      return { allowed: false, needsApproval: false };
    case 'ALLOWED':
      return { allowed: true, needsApproval: false };
    default:
      return { allowed: true, needsApproval: true };
  }
}
