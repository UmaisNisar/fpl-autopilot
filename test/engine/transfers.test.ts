import { describe, expect, it } from 'vitest';

import { evaluateTransfers, hitCostFor, shouldTransfer } from '@/lib/engine/transfers';
import type { PlayerProjection } from '@/lib/engine/types';
import { DEFAULT_WEIGHTS, type Weights } from '@/lib/engine/weights';
import type { PositionShort } from '@/lib/fpl/types';

/**
 * Transfer evaluation is where the engine can lose real points: a move that is
 * illegal, unaffordable, or simply not worth the hit. Every rejection path is
 * covered here, plus the mirrored-pair bug that once listed the same two-player
 * plan twice.
 */

let nextId = 100;

function make(
  position: PositionShort,
  perWeek: number,
  over: Partial<PlayerProjection> = {},
): PlayerProjection {
  const id = nextId++;
  const events = [1, 2, 3, 4, 5];
  return {
    playerId: id,
    name: over.name ?? `${position}${id}`,
    position,
    teamId: over.teamId ?? 1,
    price: over.price ?? 5,
    fixtures: events.map((event) => ({
      event,
      opponent: 'OPP',
      isHome: true,
      difficulty: 3,
      expectedMinutes: 90,
      playProbability: 1,
      sixtyProbability: 1,
      cleanSheetProbability: 0.3,
      points: perWeek,
      components: {
        appearance: 2,
        goals: 0,
        assists: 0,
        cleanSheet: 0,
        concede: 0,
        saves: 0,
        defcon: 0,
        bonus: 0,
        cards: 0,
      },
    })),
    next: perWeek,
    horizon: perWeek * 5,
    horizonRaw: perWeek * 5,
    ceiling: perWeek * 2,
    haulProbability: 0.1,
    availability: 1,
    ...over,
  };
}

/** A legal squad with one obviously weak midfielder to upgrade. */
function squad(): PlayerProjection[] {
  const players: PlayerProjection[] = [];
  for (let i = 0; i < 2; i++) players.push(make('GKP', 3, { teamId: 10 + i, price: 4.5 }));
  for (let i = 0; i < 5; i++) players.push(make('DEF', 4, { teamId: 20 + i, price: 5 }));
  for (let i = 0; i < 4; i++) players.push(make('MID', 6, { teamId: 30 + i, price: 7 }));
  players.push(make('MID', 1, { teamId: 34, price: 5, name: 'Weak' }));
  for (let i = 0; i < 3; i++) players.push(make('FWD', 5, { teamId: 40 + i, price: 7 }));
  return players;
}

const base = {
  startEvent: 1,
  weights: DEFAULT_WEIGHTS,
};

describe('hit cost', () => {
  it('charges four per transfer beyond the free allowance', () => {
    expect(hitCostFor(1, 1, false)).toBe(0);
    expect(hitCostFor(2, 1, false)).toBe(4);
    expect(hitCostFor(3, 1, false)).toBe(8);
    expect(hitCostFor(2, 2, false)).toBe(0);
  });

  it('charges nothing when transfers are unlimited', () => {
    expect(hitCostFor(5, 1, true)).toBe(0);
  });
});

describe('option ranking', () => {
  it('always includes rolling the transfer as a baseline', () => {
    const analysis = evaluateTransfers({
      ...base,
      squad: squad(),
      candidates: [make('MID', 9, { teamId: 50, price: 5, name: 'Strong' })],
      bank: 0,
      freeTransfers: 1,
    });
    expect(analysis.roll.moves).toHaveLength(0);
    expect(analysis.ranked.some((o) => o.moves.length === 0)).toBe(true);
  });

  it('never lists the same plan twice with the legs swapped', () => {
    // Regression: the pair search applies one move then the other, so every
    // two-transfer plan was produced in both orders and both were shown.
    const analysis = evaluateTransfers({
      ...base,
      squad: squad(),
      candidates: [
        make('MID', 9, { teamId: 50, price: 5, name: 'A' }),
        make('MID', 9, { teamId: 51, price: 7, name: 'B' }),
        make('DEF', 9, { teamId: 52, price: 5, name: 'C' }),
      ],
      bank: 5,
      freeTransfers: 2,
    });

    const keys = analysis.ranked.map((o) =>
      o.moves
        .map((m) => `${m.outId}>${m.inId}`)
        .sort()
        .join(','),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('finds the obvious upgrade when one exists', () => {
    const strong = make('MID', 9, { teamId: 50, price: 5, name: 'Strong' });
    const analysis = evaluateTransfers({
      ...base,
      squad: squad(),
      candidates: [strong],
      bank: 0,
      freeTransfers: 1,
    });
    expect(analysis.best.moves[0]?.inName).toBe('Strong');
    expect(analysis.best.moves[0]?.outName).toBe('Weak');
    expect(analysis.edgeOverRoll).toBeGreaterThan(0);
  });
});

describe('rejections', () => {
  it('will not buy a player it cannot afford', () => {
    const analysis = evaluateTransfers({
      ...base,
      squad: squad(),
      candidates: [make('MID', 20, { teamId: 50, price: 99, name: 'Unaffordable' })],
      bank: 0,
      freeTransfers: 1,
    });
    expect(analysis.ranked.every((o) => o.moves.every((m) => m.inName !== 'Unaffordable'))).toBe(
      true,
    );
  });

  it('will not swap across positions', () => {
    const analysis = evaluateTransfers({
      ...base,
      squad: squad(),
      candidates: [make('FWD', 20, { teamId: 50, price: 5, name: 'WrongPosition' })],
      bank: 5,
      freeTransfers: 1,
    });
    const moves = analysis.ranked.flatMap((o) => o.moves);
    for (const move of moves) {
      if (move.inName !== 'WrongPosition') continue;
      // If it appears at all it must have replaced a forward, never the weak
      // midfielder, or the squad shape would be illegal.
      expect(move.outName.startsWith('FWD')).toBe(true);
    }
  });

  it('will not take a fourth player from one club', () => {
    const players = squad();
    // Three midfielders already share a club.
    players[7].teamId = 77;
    players[8].teamId = 77;
    players[9].teamId = 77;

    const analysis = evaluateTransfers({
      ...base,
      squad: players,
      candidates: [make('DEF', 20, { teamId: 77, price: 5, name: 'FourthFromClub' })],
      bank: 5,
      freeTransfers: 1,
    });
    expect(analysis.ranked.every((o) => o.moves.every((m) => m.inName !== 'FourthFromClub'))).toBe(
      true,
    );
  });
});

describe('whether to pull the trigger', () => {
  const marginal = make('MID', 1.15, { teamId: 50, price: 5, name: 'Marginal' });
  const strong = make('MID', 9, { teamId: 50, price: 5, name: 'Strong' });

  it('takes a clear upgrade', () => {
    const analysis = evaluateTransfers({
      ...base,
      squad: squad(),
      candidates: [strong],
      bank: 0,
      freeTransfers: 1,
    });
    expect(shouldTransfer(analysis, DEFAULT_WEIGHTS)).toBe(true);
  });

  it('holds when the gain does not clear the configured threshold', () => {
    // The shipped threshold is zero, so this is checked against a stricter
    // weight set: the rule is what matters, not today's value.
    const strict: Weights = { ...DEFAULT_WEIGHTS, transferThreshold: 5 };
    const analysis = evaluateTransfers({
      ...base,
      squad: squad(),
      candidates: [marginal],
      bank: 0,
      freeTransfers: 1,
      weights: strict,
    });
    expect(shouldTransfer(analysis, strict)).toBe(false);
  });

  it('prices a hit into the comparison', () => {
    const withFree = evaluateTransfers({
      ...base,
      squad: squad(),
      candidates: [strong],
      bank: 0,
      freeTransfers: 1,
    });
    const withoutFree = evaluateTransfers({
      ...base,
      squad: squad(),
      candidates: [strong],
      bank: 0,
      freeTransfers: 0,
    });
    const paid = withoutFree.ranked.find((o) => o.moves.length === 1);
    const free = withFree.ranked.find((o) => o.moves.length === 1);
    expect(paid?.hitCost).toBe(4);
    expect(free?.hitCost).toBe(0);
    expect(paid!.net).toBeLessThan(free!.net);
  });

  it('charges no hit when transfers are unlimited', () => {
    const analysis = evaluateTransfers({
      ...base,
      squad: squad(),
      candidates: [strong],
      bank: 0,
      freeTransfers: 0,
      unlimitedTransfers: true,
    });
    expect(analysis.ranked.every((o) => o.hitCost === 0)).toBe(true);
  });
});
