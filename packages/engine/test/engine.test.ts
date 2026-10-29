import { describe, expect, it } from 'vitest';
import {
  addWorkingDays,
  approvalChainFor,
  EngineConfigError,
  evaluateFinding,
  evaluateInspection,
  ladderStepFor,
  overrideCounterDelta,
  PriorOccurrence,
  roundMoney,
  uuidv7,
  UUID_V7_PATTERN,
  ViolationRule,
} from '../src';

const ctx = {
  inspectionDate: '2027-03-10T09:00:00+04:00', // Wednesday in Dubai
  timeZone: 'Asia/Dubai',
  weekendDays: [6, 7],
};

/** Community-compliance style ladder: warning -> final warning -> penalty. */
const overcrowding: ViolationRule = {
  violationCode: 'OC',
  repetitionStrategy: 'INSPECTABLE',
  repeatWindowDays: 365,
  resetPolicy: 'NONE',
  fineMode: 'LADDER',
  followUpDays: { MINOR: 21, MAJOR: 10, CRITICAL: 0 },
  calendarDays: true,
  severityOverride: 'WITH_APPROVAL',
  ladder: [
    { fromOccurrence: 1, toOccurrence: 1, actionCode: 'WARNING', severity: 'MINOR', fineAmount: 0, requiresManagerReview: false, requiresCommitteeReview: false },
    { fromOccurrence: 2, toOccurrence: 2, actionCode: 'FINAL_WARNING', severity: 'MAJOR', fineAmount: 0, requiresManagerReview: true, requiresCommitteeReview: false },
    { fromOccurrence: 3, toOccurrence: null, actionCode: 'PENALTY', severity: 'CRITICAL', fineAmount: 10000, requiresManagerReview: true, requiresCommitteeReview: true },
  ],
};

/** PRD formula: final_fine = base_fine x multiplier^(n-1), counted per party per year. */
const fireExit: ViolationRule = {
  violationCode: 'FS-01',
  repetitionStrategy: 'PARTY_PER_YEAR',
  repeatWindowDays: null,
  resetPolicy: 'NONE',
  fineMode: 'MULTIPLIER',
  baseFine: 1000,
  fineMultiplier: 1.5,
  fineCap: 5000,
  followUpDays: { MINOR: 7, MAJOR: 3, CRITICAL: 0 },
  calendarDays: false,
  severityOverride: 'NOT_ALLOWED',
  ladder: [
    { fromOccurrence: 1, toOccurrence: 2, actionCode: 'PENALTY', severity: 'MAJOR', requiresManagerReview: true, requiresCommitteeReview: false },
    { fromOccurrence: 3, toOccurrence: null, actionCode: 'DOUBLE_PENALTY', severity: 'CRITICAL', requiresManagerReview: true, requiresCommitteeReview: true },
  ],
};

const occ = (over: Partial<PriorOccurrence>): PriorOccurrence => ({
  violationCode: 'OC',
  scopeType: 'INSPECTABLE',
  inspectableId: 'villa-1',
  partyId: null,
  occurredAt: '2027-01-15T10:00:00+04:00',
  isCounted: true,
  ...over,
});

describe('occurrence counting and ladder', () => {
  it('first occurrence gives a warning with a 21-day follow-up', () => {
    const r = evaluateFinding({ violationCode: 'OC', inspectableId: 'villa-1', partyIds: [] }, overcrowding, [], ctx);
    expect(r.occurrence).toBe(1);
    expect(r.actionCode).toBe('WARNING');
    expect(r.resolveBy).toBe('2027-03-31');
    expect(r.review).toBe('NONE');
    expect(r.recordOccurrence).toBe(true);
  });

  it('third occurrence escalates to a committee-reviewed penalty, due immediately', () => {
    const prior = [occ({ occurredAt: '2026-11-01T10:00:00+04:00' }), occ({})];
    const r = evaluateFinding({ violationCode: 'OC', inspectableId: 'villa-1', partyIds: [] }, overcrowding, prior, ctx);
    expect(r.occurrence).toBe(3);
    expect(r.actionCode).toBe('PENALTY');
    expect(r.fine).toBe(10000);
    expect(r.review).toBe('COMMITTEE');
    expect(r.resolveBy).toBe('2027-03-10');
  });

  it('ignores occurrences outside the repeat window, on other inspectables, uncounted or later', () => {
    const prior = [
      occ({ occurredAt: '2025-12-01T10:00:00+04:00' }), // > 365 days before
      occ({ inspectableId: 'villa-2' }),
      occ({ isCounted: false }),
      occ({ occurredAt: '2027-03-11T10:00:00+04:00' }), // after the inspection
      occ({ violationCode: 'OTHER' }),
    ];
    const r = evaluateFinding({ violationCode: 'OC', inspectableId: 'villa-1', partyIds: [] }, overcrowding, prior, ctx);
    expect(r.occurrence).toBe(1);
  });

  it('carried-forward findings are not counted again', () => {
    const r = evaluateFinding(
      { violationCode: 'OC', inspectableId: 'villa-1', partyIds: [], carriedForward: true },
      overcrowding,
      [occ({})],
      ctx,
    );
    expect(r.occurrence).toBe(1);
    expect(r.recordOccurrence).toBe(false);
  });

  it('beyond the last bounded step uses the highest step below', () => {
    const ladder = overcrowding.ladder.map((s) => ({ ...s, toOccurrence: s.fromOccurrence }));
    expect(ladderStepFor(ladder, 7).actionCode).toBe('PENALTY');
  });
});

describe('PRD multiplier formula, party strategy and yearly reset', () => {
  const p = (partyId: string, occurredAt: string): PriorOccurrence =>
    occ({ violationCode: 'FS-01', scopeType: 'PARTY', inspectableId: null, partyId, occurredAt });

  it('fine = base x 1.5^(n-1), using the worst party, capped', () => {
    const prior = [p('contractor', '2027-01-05T10:00:00+04:00'), p('contractor', '2027-02-05T10:00:00+04:00')];
    const r = evaluateFinding({ violationCode: 'FS-01', inspectableId: 'site-9', partyIds: ['owner', 'contractor'] }, fireExit, prior, ctx);
    expect(r.scopeOccurrences.map((s) => s.occurrenceNo).sort()).toEqual([1, 3]);
    expect(r.occurrence).toBe(3);
    expect(r.fine).toBe(2250); // 1000 x 1.5^2
    expect(r.actionCode).toBe('DOUBLE_PENALTY');
  });

  it('cap applies', () => {
    const prior = Array.from({ length: 6 }, (_, i) => p('owner', `2027-01-0${i + 1}T10:00:00+04:00`));
    const r = evaluateFinding({ violationCode: 'FS-01', inspectableId: 'x', partyIds: ['owner'] }, fireExit, prior, ctx);
    expect(r.fine).toBe(5000);
  });

  it('per-year strategy ignores occurrences from last year (Dubai time zone)', () => {
    // 31 Dec 2026 21:00 UTC is 1 Jan 2027 01:00 in Dubai -> counts in 2027
    const prior = [p('owner', '2026-12-31T10:00:00+04:00'), p('owner', '2026-12-31T21:00:00Z')];
    const r = evaluateFinding({ violationCode: 'FS-01', inspectableId: 'x', partyIds: ['owner'] }, fireExit, prior, ctx);
    expect(r.occurrence).toBe(2);
    expect(r.scopeOccurrences[0].periodKey).toBe('2027');
  });

  it('working days skip the Saturday-Sunday weekend', () => {
    // Wed 10 Mar + 3 working days = Mon 15 Mar
    const r = evaluateFinding({ violationCode: 'FS-01', inspectableId: 'x', partyIds: ['owner'] }, fireExit, [], ctx);
    expect(r.severity).toBe('MAJOR');
    expect(r.resolveBy).toBe('2027-03-15');
    expect(addWorkingDays('2027-03-12', 1, [6, 7])).toBe('2027-03-15');
  });

  it('party strategy without parties warns and falls back to first occurrence', () => {
    const r = evaluateFinding({ violationCode: 'FS-01', inspectableId: 'x', partyIds: [] }, fireExit, [], ctx);
    expect(r.warnings).toContain('NO_PARTY_FOR_PARTY_STRATEGY');
    expect(r.occurrence).toBe(1);
    expect(r.recordOccurrence).toBe(false);
  });
});

describe('inspection-level rules', () => {
  const rules = { OC: overcrowding, 'FS-01': fireExit };
  const thresholds = [
    { minAmount: 0, maxAmount: 50000, approvalChain: ['SECTION_MANAGER', 'COMMITTEE'] },
    { minAmount: 50000.01, maxAmount: null, approvalChain: ['SECTION_MANAGER', 'COMMITTEE', 'CEO'] },
  ];

  it('no findings -> NO_FINDINGS, no review', () => {
    const r = evaluateInspection({ findings: [], rules, prior: [], thresholds, ctx });
    expect(r).toMatchObject({ category: 'NO_FINDINGS', totalFine: 0, followUpDate: null, review: 'NONE', approvalChain: [] });
  });

  it('category, single total, earliest follow-up and highest review', () => {
    const r = evaluateInspection({
      findings: [
        { violationCode: 'OC', inspectableId: 'villa-1', partyIds: [] },
        { violationCode: 'FS-01', inspectableId: 'villa-1', partyIds: ['owner'] },
      ],
      rules,
      prior: [],
      thresholds,
      ctx,
    });
    expect(r.category).toBe('WARNING');
    expect(r.totalFine).toBe(1000);
    expect(r.followUpDate).toBe('2027-03-15');
    expect(r.review).toBe('MANAGER');
    expect(r.approvalChain).toEqual(['SECTION_MANAGER']);
  });

  it('committee reviews follow amount thresholds; above AED 50,000 adds the CEO', () => {
    expect(approvalChainFor('COMMITTEE', 60000, thresholds)).toEqual(['SECTION_MANAGER', 'COMMITTEE', 'CEO']);
    expect(approvalChainFor('COMMITTEE', 10000, thresholds)).toEqual(['SECTION_MANAGER', 'COMMITTEE']);
    expect(approvalChainFor('COMMITTEE', 10000, [])).toEqual(['SECTION_MANAGER', 'COMMITTEE']);
    expect(approvalChainFor('MANAGER', 100, thresholds)).toEqual(['SECTION_MANAGER']);
  });

  it('rejects a violation code repeated in one inspection', () => {
    expect(() =>
      evaluateInspection({
        findings: [
          { violationCode: 'OC', inspectableId: 'v', partyIds: [] },
          { violationCode: 'OC', inspectableId: 'v', partyIds: [] },
        ],
        rules,
        prior: [],
        thresholds,
        ctx,
      }),
    ).toThrow(EngineConfigError);
  });

  it('rejects an unknown violation code', () => {
    expect(() =>
      evaluateInspection({ findings: [{ violationCode: 'X', inspectableId: 'v', partyIds: [] }], rules, prior: [], thresholds, ctx }),
    ).toThrow(/No rule configured/);
  });
});

describe('overrides, money and ids', () => {
  it('counter changes only on approved overrides', () => {
    expect(overrideCounterDelta('MAJOR', 'MINOR', true)).toBe(-1);
    expect(overrideCounterDelta('MINOR', 'CRITICAL', true)).toBe(1);
    expect(overrideCounterDelta('MAJOR', 'MINOR', false)).toBe(0);
  });

  it('rounds to fils', () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(3375.4999)).toBe(3375.5);
  });

  it('generates sortable UUID v7', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(UUID_V7_PATTERN);
    expect(a < b).toBe(true);
  });
});
