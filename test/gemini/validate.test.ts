import { describe, expect, it } from 'vitest';

import snapshotFixture from '../fixtures/snapshot.json';
import { isLegalXi } from '@/lib/analysis/lineup';
import { buildFallbackPlan, parsePlanJson, resolvePlayer, validatePlan } from '@/lib/gemini/validate';
import type { SquadPlayer, TeamSnapshot } from '@/lib/fpl/model';

/**
 * The app's one hard guarantee: a bad model response can never break the
 * screen. Every case here is something a language model has plausibly done --
 * invented players, illegal formations, unaffordable transfers, wrong types,
 * prose wrapped around the JSON -- and each must still yield a legal plan.
 */

const snapshot = snapshotFixture as unknown as TeamSnapshot;

function candidate(
  id: number,
  name: string,
  team: string,
  position: SquadPlayer['position'],
  price: number,
): SquadPlayer {
  return {
    id,
    name,
    fullName: name,
    position,
    teamShort: team,
    teamName: team,
    teamCode: 1,
    price,
    slot: 0,
    isStarter: false,
    isCaptain: false,
    isViceCaptain: false,
    totalPoints: 40,
    form: 5,
    pointsPerGame: 5,
    minutes: 900,
    starts: 10,
    goals: 4,
    assists: 4,
    bonus: 6,
    xgi90: 0.6,
    xgc90: 1.1,
    defcon90: 3,
    status: 'a',
    news: '',
    chanceOfPlaying: null,
    selectedBy: 20,
    epNext: 5,
    fixtures: [
      { event: snapshot.gameweek.id, opponent: 'XXX', isHome: true, difficulty: 3, kickoff: null },
    ],
    fdr: 3,
    projected: 25,
    projNext: 5,
  };
}

const candidates: SquadPlayer[] = [
  candidate(9001, 'Saka', 'ARS', 'MID', 10.0),
  candidate(9002, 'Palmer', 'CHE', 'MID', 10.5),
  candidate(9006, 'Mega Expensive', 'MCI', 'MID', 99.9),
  candidate(9004, 'Isak', 'NEW', 'FWD', 9.1),
  // Affordable when Maguire (5.0) is sold with an empty bank.
  candidate(9007, 'Budget Def', 'BOU', 'DEF', 4.5),
  // Exactly 0.1m out of reach on the same swap.
  candidate(9008, 'Just Too Dear', 'BOU', 'DEF', 5.1),
];

const ctx = { snapshot, candidates };
const goodXi = snapshot.squad.filter((p) => p.isStarter).map((p) => p.name);
const goodBench = snapshot.squad.filter((p) => !p.isStarter).map((p) => p.name);

const plan = (over: Record<string, unknown> = {}) => ({
  transfer_decision: { action: 'hold', moves: [], take_hit: false, hit_cost: 0 },
  captain: 'Haaland',
  vice_captain: 'Gvardiol',
  formation: '3-4-3',
  starting_xi: goodXi,
  bench_order: goodBench,
  chip: 'none',
  confidence: 'high',
  summary: 'x',
  ...over,
});

/** Everything the UI depends on being true, whatever the model returned. */
function expectRenderable(result: ReturnType<typeof validatePlan>) {
  expect(isLegalXi(result.resolved.startingXi)).toBe(true);
  expect(result.plan.startingXi).toHaveLength(11);
  expect(result.plan.benchOrder).toHaveLength(4);
  expect(new Set(result.resolved.startingXi.map((p) => p.id)).size).toBe(11);
  expect(result.finalSquad).toHaveLength(15);
  expect(result.plan.startingXi).toContain(result.plan.captain);
  expect(result.plan.captain).not.toBe(result.plan.viceCaptain);
  expect(result.plan.summary.length).toBeGreaterThan(0);
  if (result.plan.chip !== 'none') {
    expect(snapshot.chips.available).toContain(result.plan.chip);
  }
}

describe('extracting JSON from a model response', () => {
  it('reads a bare object, a fenced block, and prose either side', () => {
    expect(parsePlanJson('{"chip":"none"}')).toEqual({ chip: 'none' });
    expect(parsePlanJson('```json\n{"chip":"none"}\n```')).toEqual({ chip: 'none' });
    expect(parsePlanJson('Sure!\n{"chip":"none"}\nHope that helps.')).toEqual({ chip: 'none' });
  });

  it('returns null rather than throwing on anything unusable', () => {
    for (const text of ['{"chip":"non', 'I cannot help with that.', '[1,2,3]', '']) {
      expect(parsePlanJson(text)).toBeNull();
    }
  });
});

describe('resolving player names', () => {
  it('matches exactly, and tolerates accents', () => {
    expect(resolvePlayer('Haaland', snapshot.squad)?.name).toBe('Haaland');
    expect(resolvePlayer('Joao Pedro', snapshot.squad)?.name).toBe('João Pedro');
  });

  it('refuses a name it cannot place', () => {
    expect(resolvePlayer('Cristiano Ronaldo', snapshot.squad)).toBeNull();
    expect(resolvePlayer('', snapshot.squad)).toBeNull();
    expect(resolvePlayer(undefined, snapshot.squad)).toBeNull();
    expect(resolvePlayer(42, snapshot.squad)).toBeNull();
  });
});

describe('a well-formed response', () => {
  it('is accepted as given', () => {
    const result = validatePlan(plan({ captain: goodXi[4], vice_captain: goodXi[5] }), ctx);
    expect(result.plan.transfer.action).toBe('hold');
    expect(result.warnings).toHaveLength(0);
    expectRenderable(result);
  });

  it('accepts a legal, affordable transfer', () => {
    const result = validatePlan(
      plan({
        transfer_decision: {
          action: 'transfer',
          moves: [{ out: 'Maguire', in: 'Budget Def', reason: 'better fixtures' }],
          take_hit: false,
          hit_cost: 0,
        },
      }),
      ctx,
    );
    expect(result.plan.transfer.moves).toHaveLength(1);
    expectRenderable(result);
  });
});

describe('rejecting bad transfers', () => {
  const swap = (out: string, into: string) =>
    plan({
      transfer_decision: {
        action: 'transfer',
        moves: [{ out, in: into, reason: 'x' }],
        take_hit: false,
        hit_cost: 0,
      },
    });

  it('drops an invented outgoing player', () => {
    const result = validatePlan(swap('Cristiano Ronaldo', 'Saka'), ctx);
    expect(result.plan.transfer.moves).toHaveLength(0);
    expectRenderable(result);
  });

  it('refuses a move that is even 0.1m out of reach', () => {
    const result = validatePlan(swap('Maguire', 'Just Too Dear'), ctx);
    expect(result.plan.transfer.moves).toHaveLength(0);
    expect(result.warnings.join(' ')).toMatch(/afford/);
  });

  it('refuses a wildly unaffordable move', () => {
    expect(validatePlan(swap('Maguire', 'Mega Expensive'), ctx).plan.transfer.moves).toHaveLength(0);
  });

  it('refuses a swap that would break the squad shape', () => {
    // A defender out for a forward in leaves 4 defenders and 4 forwards.
    const result = validatePlan(swap('Maguire', 'Isak'), ctx);
    expect(result.plan.transfer.moves).toHaveLength(0);
    expect(result.warnings.join(' ')).toMatch(/illegal squad shape/);
  });
});

describe('repairing the rest', () => {
  it('rebuilds an illegal formation', () => {
    // One keeper, five defenders and five midfielders: eleven players, but no
    // forward, which the game would reject.
    const byPosition = (pos: string) =>
      snapshot.squad.filter((p) => p.position === pos).map((p) => p.name);
    const noForwards = [
      ...byPosition('GKP').slice(0, 1),
      ...byPosition('DEF'),
      ...byPosition('MID'),
    ];
    expect(noForwards).toHaveLength(11);

    const result = validatePlan(plan({ formation: '5-5-0', starting_xi: noForwards }), ctx);
    expectRenderable(result);
    expect(result.warnings.join(' ')).toMatch(/rebuilt/);
  });

  it('refuses a chip that is not available', () => {
    const result = validatePlan(plan({ chip: 'bboost' }), ctx);
    expect(result.plan.chip).toBe('none');
    expect(result.warnings.join(' ')).toMatch(/not available/);
  });

  it('repairs a captain who is not in the eleven, or duplicated', () => {
    const result = validatePlan(plan({ captain: 'Kinsky', vice_captain: 'Kinsky' }), ctx);
    expectRenderable(result);
  });

  it('recomputes the hit rather than trusting the model', () => {
    const free = snapshot.finances.freeTransfers;
    const result = validatePlan(
      plan({
        transfer_decision: {
          action: 'transfer',
          moves: [
            { out: 'Maguire', in: 'Budget Def', reason: 'a' },
            { out: 'Mbeumo', in: 'Saka', reason: 'b' },
            { out: 'Szoboszlai', in: 'Palmer', reason: 'c' },
          ],
          take_hit: false,
          hit_cost: 0,
        },
      }),
      ctx,
    );
    const expected = Math.max(0, result.plan.transfer.moves.length - free) * 4;
    expect(result.plan.transfer.hitCost).toBe(expected);
    expectRenderable(result);
  });

  it('corrects the formation string to match the eleven', () => {
    const result = validatePlan(plan({ formation: '1-2-3' }), ctx);
    const count = (pos: string) =>
      result.resolved.startingXi.filter((p) => p.position === pos).length;
    expect(result.plan.formation).toBe(`${count('DEF')}-${count('MID')}-${count('FWD')}`);
  });
});

describe('surviving malformed output', () => {
  const nonsense: Record<string, unknown>[] = [
    {},
    {
      transfer_decision: 'nope',
      captain: 42,
      vice_captain: null,
      formation: ['3', '4', '3'],
      starting_xi: 'Haaland',
      bench_order: { a: 1 },
      chip: 12,
      confidence: 'extremely high',
      summary: 999,
    },
    {
      transfer_decision: null,
      captain: null,
      vice_captain: null,
      formation: null,
      starting_xi: null,
      bench_order: null,
      chip: null,
      confidence: null,
      summary: null,
    },
    plan({ starting_xi: Array(11).fill('Haaland') }),
  ];

  it.each(nonsense.map((raw, i) => [i, raw] as const))(
    'still produces a legal plan (case %i)',
    (_i, raw) => {
      const result = validatePlan(raw, ctx);
      expectRenderable(result);
    },
  );
});

describe('reporting a departure from the engine', () => {
  it('says what a different choice is projected to cost', () => {
    const engine = {
      recommendation: { moves: [{ outId: 229, inId: 9007 }], captainId: 426 },
      options: [
        { moves: [{ outId: 229, inId: 9007 }], net: 6 },
        { moves: [], net: 1 },
      ],
    };
    const result = validatePlan(plan(), { ...ctx, engine });
    expect(result.warnings.join(' ')).toMatch(/different transfer/);
  });
});

describe('the fallback plan', () => {
  it('is legal and explains itself', () => {
    const result = buildFallbackPlan(snapshot, 'Gemini was unavailable.');
    expectRenderable(result);
    expect(result.plan.transfer.action).toBe('hold');
    expect(result.warnings).toContain('Gemini was unavailable.');
  });
});
