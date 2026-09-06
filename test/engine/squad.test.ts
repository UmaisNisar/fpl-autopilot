import { describe, expect, it } from 'vitest';

import {
  bestEleven,
  buildEventPoints,
  hasLegalShape,
  horizonEvents,
  orderBench,
  pointsFor,
  respectsClubLimit,
  squadValue,
} from '@/lib/engine/squad';
import type { PlayerProjection } from '@/lib/engine/types';
import { DEFAULT_WEIGHTS } from '@/lib/engine/weights';
import type { PositionShort } from '@/lib/fpl/types';

/**
 * The lineup optimiser is the one component that must never be wrong: an
 * illegal XI is not a bad recommendation, it is one the game would reject.
 */

let nextId = 1;

function projection(
  position: PositionShort,
  pointsByEvent: Record<number, number>,
  over: Partial<PlayerProjection> = {},
): PlayerProjection {
  const id = nextId++;
  const fixtures = Object.entries(pointsByEvent).map(([event, points]) => ({
    event: Number(event),
    opponent: 'OPP',
    isHome: true,
    difficulty: 3,
    expectedMinutes: 90,
    playProbability: 1,
    sixtyProbability: 1,
    cleanSheetProbability: 0.3,
    points,
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
  }));

  return {
    playerId: id,
    name: `${position}${id}`,
    position,
    teamId: 1,
    price: 5,
    fixtures,
    next: pointsByEvent[1] ?? 0,
    horizon: Object.values(pointsByEvent).reduce((s, v) => s + v, 0),
    horizonRaw: Object.values(pointsByEvent).reduce((s, v) => s + v, 0),
    ceiling: 0,
    haulProbability: 0,
    availability: 1,
    ...over,
  };
}

/** A legal 2/5/5/3 squad where points descend within each position. */
function squadOf(points: Partial<Record<PositionShort, number[]>> = {}): PlayerProjection[] {
  const shape: Record<PositionShort, number> = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
  const squad: PlayerProjection[] = [];
  for (const pos of ['GKP', 'DEF', 'MID', 'FWD'] as PositionShort[]) {
    const values = points[pos] ?? Array.from({ length: shape[pos] }, (_, i) => 10 - i);
    for (let i = 0; i < shape[pos]; i++) squad.push(projection(pos, { 1: values[i] ?? 1 }));
  }
  return squad;
}

const count = (players: PlayerProjection[], pos: PositionShort) =>
  players.filter((p) => p.position === pos).length;

describe('best eleven', () => {
  it('always returns a legal formation', () => {
    const squad = squadOf();
    const index = buildEventPoints(squad);
    const { starters } = bestEleven(squad, 1, index);

    expect(starters).toHaveLength(11);
    expect(count(starters, 'GKP')).toBe(1);
    expect(count(starters, 'DEF')).toBeGreaterThanOrEqual(3);
    expect(count(starters, 'DEF')).toBeLessThanOrEqual(5);
    expect(count(starters, 'MID')).toBeGreaterThanOrEqual(2);
    expect(count(starters, 'MID')).toBeLessThanOrEqual(5);
    expect(count(starters, 'FWD')).toBeGreaterThanOrEqual(1);
    expect(count(starters, 'FWD')).toBeLessThanOrEqual(3);
  });

  it('benches exactly the four it did not pick, with no overlap', () => {
    const squad = squadOf();
    const index = buildEventPoints(squad);
    const { starters, bench } = bestEleven(squad, 1, index);

    expect(bench).toHaveLength(4);
    const ids = new Set([...starters, ...bench].map((p) => p.playerId));
    expect(ids.size).toBe(15);
  });

  it('picks the highest-scoring legal shape, not a fixed one', () => {
    // Five strong defenders and weak forwards should produce five at the back.
    // The fourth midfielder is deliberately worth more than a second forward,
    // so 5-4-1 wins outright rather than tying with 5-3-2.
    const squad = squadOf({
      DEF: [9, 9, 9, 9, 9],
      MID: [8, 8, 4, 3, 1],
      FWD: [1, 1, 1],
    });
    const index = buildEventPoints(squad);
    const { starters, formation } = bestEleven(squad, 1, index);
    expect(count(starters, 'DEF')).toBe(5);
    expect(formation).toBe('5-4-1');
  });

  it('respects the one-forward minimum even when forwards are useless', () => {
    const squad = squadOf({ DEF: [9, 9, 9, 9, 9], MID: [9, 9, 9, 9, 9], FWD: [0, 0, 0] });
    const index = buildEventPoints(squad);
    const { starters } = bestEleven(squad, 1, index);
    expect(count(starters, 'FWD')).toBe(1);
  });

  it('reports the formation that matches the eleven it chose', () => {
    const squad = squadOf();
    const index = buildEventPoints(squad);
    const { starters, formation } = bestEleven(squad, 1, index);
    expect(formation).toBe(
      `${count(starters, 'DEF')}-${count(starters, 'MID')}-${count(starters, 'FWD')}`,
    );
  });
});

describe('bench order', () => {
  it('puts the reserve keeper first, then outfielders by projection', () => {
    const players = [
      projection('FWD', { 1: 3 }),
      projection('GKP', { 1: 0 }),
      projection('DEF', { 1: 5 }),
      projection('MID', { 1: 1 }),
    ];
    const ordered = orderBench(players, (p) => p.next);
    expect(ordered[0].position).toBe('GKP');
    expect(ordered.slice(1).map((p) => p.next)).toEqual([5, 3, 1]);
  });
});

describe('squad value across the horizon', () => {
  it('counts only the eleven that play, plus the captain', () => {
    const squad = squadOf({ DEF: [9, 9, 9, 9, 9] });
    const index = buildEventPoints(squad);
    const eleven = bestEleven(squad, 1, index);

    const withoutCaptain = squadValue(squad, [1], index, DEFAULT_WEIGHTS, {
      includeCaptain: false,
    });
    expect(withoutCaptain).toBeCloseTo(eleven.total, 6);

    const best = Math.max(...eleven.starters.map((p) => pointsFor(index, p.playerId, 1)));
    const withCaptain = squadValue(squad, [1], index, DEFAULT_WEIGHTS);
    expect(withCaptain).toBeCloseTo(eleven.total + best, 6);
  });

  it('discounts later gameweeks', () => {
    const squad = squadOf().map((p) => projection(p.position, { 1: 5, 2: 5 }));
    const index = buildEventPoints(squad);
    const oneWeek = squadValue(squad, [1], index, DEFAULT_WEIGHTS);
    const twoWeeks = squadValue(squad, [1, 2], index, DEFAULT_WEIGHTS);
    // The second week is worth less than the first.
    expect(twoWeeks - oneWeek).toBeLessThan(oneWeek);
    expect(twoWeeks).toBeGreaterThan(oneWeek);
  });

  it('scores a blank gameweek as nothing rather than crashing', () => {
    const squad = squadOf();
    const index = buildEventPoints(squad);
    expect(squadValue(squad, [99], index, DEFAULT_WEIGHTS)).toBe(0);
  });
});

describe('squad legality', () => {
  it('accepts 2/5/5/3 and rejects anything else', () => {
    expect(hasLegalShape(squadOf())).toBe(true);
    expect(hasLegalShape(squadOf().slice(0, 14))).toBe(false);
    expect(hasLegalShape([...squadOf(), projection('MID', { 1: 1 })])).toBe(false);
  });

  it('allows three players from a club but not four', () => {
    const three = [1, 1, 1, 2].map((teamId) => projection('MID', { 1: 1 }, { teamId }));
    expect(respectsClubLimit(three)).toBe(true);
    const four = [1, 1, 1, 1].map((teamId) => projection('MID', { 1: 1 }, { teamId }));
    expect(respectsClubLimit(four)).toBe(false);
  });
});

describe('horizon', () => {
  it('starts at the upcoming gameweek and runs for the configured length', () => {
    const events = horizonEvents(7, DEFAULT_WEIGHTS);
    expect(events[0]).toBe(7);
    expect(events).toHaveLength(DEFAULT_WEIGHTS.horizon);
  });
});

describe('event points index', () => {
  it('sums both fixtures of a double gameweek', () => {
    const doubled = projection('MID', {});
    doubled.fixtures = [
      { ...projection('MID', { 5: 4 }).fixtures[0], event: 5, points: 4 },
      { ...projection('MID', { 5: 3 }).fixtures[0], event: 5, points: 3 },
    ];
    const index = buildEventPoints([doubled]);
    expect(pointsFor(index, doubled.playerId, 5)).toBe(7);
  });

  it('returns zero for a player with no fixture that week', () => {
    const player = projection('MID', { 1: 5 });
    const index = buildEventPoints([player]);
    expect(pointsFor(index, player.playerId, 2)).toBe(0);
  });
});
