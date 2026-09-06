import { describe, expect, it } from 'vitest';

import { CURRENT_RULES, poissonAtLeast, projectPlayer } from '@/lib/engine/expected';
import type { ProjectionContext } from '@/lib/engine/expected';
import { computeTeamRatings } from '@/lib/engine/strength';
import { emptyStatLine, type PlayerFixture, type PlayerState, type TeamState } from '@/lib/engine/types';
import { DEFAULT_WEIGHTS, type Weights } from '@/lib/engine/weights';
import type { PositionShort } from '@/lib/fpl/types';

/**
 * The expected-points model. The property that matters most is the one the
 * calibration layer depends on: rescaling must not reorder players, because
 * every transfer and captaincy decision is made on that order.
 */

const teams: TeamState[] = [1, 2, 3, 4].map((id) => ({
  id,
  shortName: `T${id}`,
  name: `Team ${id}`,
  played: 5,
  goalsFor: 8,
  goalsAgainst: 6,
  xgFor: 7.5,
  xgAgainst: 6.5,
}));

function context(weights: Weights = DEFAULT_WEIGHTS): ProjectionContext {
  return {
    ratings: computeTeamRatings(teams, [], weights),
    weights,
    leagueMeanGoals: weights.leagueMeanGoals,
    rules: CURRENT_RULES,
  };
}

function player(position: PositionShort, over: Partial<PlayerState> = {}): PlayerState {
  return {
    id: 1,
    name: 'Test',
    position,
    teamId: 1,
    price: 7,
    status: 'a',
    chanceOfPlaying: null,
    news: '',
    season: {
      ...emptyStatLine(),
      games: 10,
      minutes: 900,
      starts: 10,
      appearances: 10,
      goals: 5,
      assists: 3,
      xg: 4.5,
      xa: 3.2,
      bonus: 8,
      defcon: 60,
      defconHits: 4,
      points: 60,
    },
    recent: {
      ...emptyStatLine(),
      games: 5,
      minutes: 450,
      starts: 5,
      appearances: 5,
      goals: 3,
      assists: 1,
      xg: 2.4,
      xa: 1.1,
      bonus: 4,
      defcon: 30,
      defconHits: 2,
      points: 32,
    },
    teamGames: 10,
    ...over,
  };
}

const fixture = (over: Partial<PlayerFixture> = {}): PlayerFixture => ({
  event: 1,
  opponentId: 2,
  opponent: 'T2',
  isHome: true,
  difficulty: 3,
  ...over,
});

describe('poisson tail', () => {
  it('is one for zero events and zero for an impossible rate', () => {
    expect(poissonAtLeast(2, 0)).toBe(1);
    expect(poissonAtLeast(0, 1)).toBe(0);
  });

  it('rises with the rate and falls with the threshold', () => {
    expect(poissonAtLeast(3, 2)).toBeGreaterThan(poissonAtLeast(1, 2));
    expect(poissonAtLeast(3, 4)).toBeLessThan(poissonAtLeast(3, 2));
  });

  it('stays a probability', () => {
    for (const lambda of [0.1, 1, 5, 20]) {
      for (const k of [1, 3, 10]) {
        const p = poissonAtLeast(lambda, k);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('projection basics', () => {
  it('scores a blank gameweek as nothing', () => {
    const projection = projectPlayer(player('MID'), [], context());
    expect(projection.next).toBe(0);
    expect(projection.horizon).toBe(0);
    expect(projection.fixtures).toHaveLength(0);
  });

  it('adds both matches of a double gameweek', () => {
    const single = projectPlayer(player('MID'), [fixture()], context());
    const double = projectPlayer(
      player('MID'),
      [fixture(), fixture({ opponentId: 3, opponent: 'T3' })],
      context(),
    );
    expect(double.next).toBeGreaterThan(single.next);
  });

  it('gives an unavailable player nothing', () => {
    const projection = projectPlayer(player('MID', { status: 'i' }), [fixture()], context());
    expect(projection.next).toBe(0);
  });

  it('keeps the component breakdown adding up to the total', () => {
    const projection = projectPlayer(player('DEF'), [fixture()], context());
    const f = projection.fixtures[0];
    const sum = Object.values(f.components).reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(f.points, 1);
  });

  it('pays clean sheets to defenders but not forwards', () => {
    const def = projectPlayer(player('DEF'), [fixture()], context());
    const fwd = projectPlayer(player('FWD'), [fixture()], context());
    expect(def.fixtures[0].components.cleanSheet).toBeGreaterThan(0);
    expect(fwd.fixtures[0].components.cleanSheet).toBe(0);
  });

  it('withholds defensive contribution from goalkeepers, and when the rules predate it', () => {
    const ctx = context();
    expect(projectPlayer(player('GKP'), [fixture()], ctx).fixtures[0].components.defcon).toBe(0);

    const oldRules: ProjectionContext = { ...ctx, rules: { defensiveContribution: false } };
    expect(projectPlayer(player('DEF'), [fixture()], oldRules).fixtures[0].components.defcon).toBe(
      0,
    );
    expect(
      projectPlayer(player('DEF'), [fixture()], ctx).fixtures[0].components.defcon,
    ).toBeGreaterThan(0);
  });

  it('discounts later gameweeks in the horizon but not the raw total', () => {
    const projection = projectPlayer(
      player('MID'),
      [fixture({ event: 1 }), fixture({ event: 2 })],
      context(),
    );
    expect(projection.horizon).toBeLessThan(projection.horizonRaw);
  });
});

describe('captaincy inputs', () => {
  it('puts the ceiling above the mean and keeps haul a probability', () => {
    const projection = projectPlayer(player('FWD'), [fixture()], context());
    expect(projection.ceiling).toBeGreaterThan(projection.next);
    expect(projection.haulProbability).toBeGreaterThanOrEqual(0);
    expect(projection.haulProbability).toBeLessThanOrEqual(1);
  });

  it('rates a striker upside above a goalkeeper', () => {
    const striker = projectPlayer(player('FWD'), [fixture()], context());
    const keeper = projectPlayer(player('GKP'), [fixture()], context());
    expect(striker.ceiling - striker.next).toBeGreaterThan(keeper.ceiling - keeper.next);
  });
});

describe('calibration', () => {
  const raw: Weights = { ...DEFAULT_WEIGHTS, calibrationSlope: 1, calibrationIntercept: 0 };

  it('is shipped switched on', () => {
    expect(DEFAULT_WEIGHTS.calibrationSlope).toBeGreaterThan(1);
  });

  it('raises projections without reordering them', () => {
    // The whole point of an affine rescale: it fixes the level while leaving
    // the ranking that decisions are made on exactly as it was.
    const squad: PlayerState[] = [
      player('FWD', { id: 1 }),
      player('MID', { id: 2 }),
      player('DEF', { id: 3 }),
      player('GKP', { id: 4 }),
      player('MID', { id: 5, season: { ...player('MID').season, goals: 0, xg: 0.2 } }),
    ];

    const before = squad.map((p) => projectPlayer(p, [fixture()], context(raw)).next);
    const after = squad.map((p) => projectPlayer(p, [fixture()], context()).next);

    const order = (values: number[]) =>
      values
        .map((v, i) => ({ v, i }))
        .sort((a, b) => b.v - a.v)
        .map((x) => x.i);

    expect(order(after)).toEqual(order(before));
    for (let i = 0; i < before.length; i++) {
      if (before[i] > 0) expect(after[i]).toBeGreaterThan(before[i]);
    }
  });

  it('never produces a negative projection', () => {
    const negativeWeights: Weights = { ...DEFAULT_WEIGHTS, calibrationIntercept: -50 };
    const projection = projectPlayer(player('DEF'), [fixture()], context(negativeWeights));
    expect(projection.next).toBeGreaterThanOrEqual(0);
  });
});
