import { describe, expect, it } from 'vitest';

import { evaluateCaptaincy } from '@/lib/engine/captain';
import { evaluateChips } from '@/lib/engine/chips';
import {
  cleanSheetProbability,
  computeTeamRatings,
  difficultyPrior,
  fixtureGoals,
} from '@/lib/engine/strength';
import { buildEventPoints } from '@/lib/engine/squad';
import type { FixtureState, PlayerProjection, TeamState } from '@/lib/engine/types';
import { DEFAULT_WEIGHTS, type Weights } from '@/lib/engine/weights';
import type { PositionShort } from '@/lib/fpl/types';

/** Team strength, captaincy and chip valuation. */

let nextId = 500;

function projection(
  position: PositionShort,
  points: number,
  over: Partial<PlayerProjection> = {},
): PlayerProjection {
  const id = nextId++;
  return {
    playerId: id,
    name: over.name ?? `${position}${id}`,
    position,
    teamId: 1,
    price: 6,
    fixtures: [
      {
        event: 1,
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
      },
    ],
    next: points,
    horizon: points * 5,
    horizonRaw: points * 5,
    ceiling: points,
    haulProbability: 0,
    availability: 1,
    ...over,
  };
}

// ---------------------------------------------------------------- strength --

describe('team strength', () => {
  const teams: TeamState[] = [1, 2, 3, 4].map((id) => ({
    id,
    shortName: `T${id}`,
    name: `Team ${id}`,
    played: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    xgFor: 0,
    xgAgainst: 0,
  }));

  const fixtures: FixtureState[] = [
    // Everyone facing team 1 is given a difficulty of 5, so team 1 is strong.
    { event: 1, teamH: 2, teamA: 1, difficultyH: 5, difficultyA: 2, finished: false, kickoff: null },
    { event: 2, teamH: 1, teamA: 3, difficultyH: 2, difficultyA: 5, finished: false, kickoff: null },
    { event: 3, teamH: 4, teamA: 1, difficultyH: 5, difficultyA: 2, finished: false, kickoff: null },
  ];

  it('reads a strength prior out of the difficulties opponents are given', () => {
    const prior = difficultyPrior(fixtures, teams);
    expect(prior.get(1)).toBeGreaterThan(prior.get(2)!);
  });

  it('normalises ratings around one', () => {
    const ratings = computeTeamRatings(teams, fixtures, DEFAULT_WEIGHTS);
    const mean =
      [...ratings.attack.values()].reduce((s, v) => s + v, 0) / ratings.attack.size;
    // Approximately, not exactly: the clamp gets the final word, so a bound
    // rating can pull the mean a little off centre.
    expect(mean).toBeGreaterThan(0.97);
    expect(mean).toBeLessThan(1.03);
  });

  it('leans on the prior when barely any matches have been played', () => {
    // Two matches of a freak scoreline should not treble a team's rating.
    const hot: TeamState[] = teams.map((t) =>
      t.id === 2 ? { ...t, played: 2, goalsFor: 12, xgFor: 11 } : { ...t, played: 2 },
    );
    const ratings = computeTeamRatings(hot, fixtures, DEFAULT_WEIGHTS);
    // Regression: the clamp used to be applied before normalisation, which
    // then divided by the mean and pushed the value straight back past it.
    for (const value of ratings.attack.values()) {
      expect(value).toBeLessThanOrEqual(DEFAULT_WEIGHTS.ratingCeiling + 1e-9);
      expect(value).toBeGreaterThanOrEqual(DEFAULT_WEIGHTS.ratingFloor - 1e-9);
    }
  });

  it('gives the home side more expected goals than the same tie away', () => {
    const ratings = computeTeamRatings(teams, fixtures, DEFAULT_WEIGHTS);
    const home = fixtureGoals(ratings, 1, 2, true, DEFAULT_WEIGHTS);
    const away = fixtureGoals(ratings, 1, 2, false, DEFAULT_WEIGHTS);
    expect(home.scored).toBeGreaterThan(away.scored);
    expect(home.conceded).toBeLessThan(away.conceded);
  });

  it('turns expected goals conceded into a clean-sheet probability', () => {
    expect(cleanSheetProbability(0)).toBe(1);
    expect(cleanSheetProbability(1)).toBeCloseTo(Math.exp(-1), 6);
    expect(cleanSheetProbability(3)).toBeLessThan(cleanSheetProbability(1));
  });
});

// --------------------------------------------------------------- captaincy --

describe('captaincy', () => {
  it('prefers upside over a marginally higher mean', () => {
    const steady = projection('DEF', 5.5, { name: 'Steady', ceiling: 6.0 });
    const explosive = projection('FWD', 5.2, { name: 'Explosive', ceiling: 12 });

    const analysis = evaluateCaptaincy([steady, explosive], 1, DEFAULT_WEIGHTS);
    expect(analysis.captain?.name).toBe('Explosive');
    expect(analysis.viceCaptain?.name).toBe('Steady');
  });

  it('falls back to the mean when upside is ignored', () => {
    const steady = projection('DEF', 5.5, { name: 'Steady', ceiling: 6.0 });
    const explosive = projection('FWD', 5.2, { name: 'Explosive', ceiling: 12 });
    const flat: Weights = { ...DEFAULT_WEIGHTS, captainUpsideWeight: 0 };

    expect(evaluateCaptaincy([steady, explosive], 1, flat).captain?.name).toBe('Steady');
  });

  it('flags a close call between the top two', () => {
    const a = projection('MID', 6, { name: 'A', ceiling: 6 });
    const b = projection('MID', 5.95, { name: 'B', ceiling: 6 });
    expect(evaluateCaptaincy([a, b], 1, DEFAULT_WEIGHTS).isCloseCall).toBe(true);
  });

  it('does not flag a clear favourite', () => {
    const a = projection('MID', 9, { name: 'A', ceiling: 14 });
    const b = projection('MID', 3, { name: 'B', ceiling: 4 });
    expect(evaluateCaptaincy([a, b], 1, DEFAULT_WEIGHTS).isCloseCall).toBe(false);
  });

  it('will not captain a player with no fixture', () => {
    const playing = projection('MID', 4, { name: 'Playing' });
    const blank = projection('FWD', 9, { name: 'Blank', fixtures: [] });
    const analysis = evaluateCaptaincy([playing, blank], 1, DEFAULT_WEIGHTS);
    expect(analysis.captain?.name).toBe('Playing');
    expect(analysis.candidates.map((c) => c.name)).not.toContain('Blank');
  });
});

// ------------------------------------------------------------------- chips --

describe('chips', () => {
  const eleven = Array.from({ length: 11 }, () => projection('MID', 5));

  function evaluate(bench: PlayerProjection[], available: Parameters<typeof evaluateChips>[0]['available'], captainExpected = 5) {
    const squad = [...eleven, ...bench];
    return evaluateChips({
      squad,
      available,
      startEvent: 1,
      index: buildEventPoints(squad),
      weights: DEFAULT_WEIGHTS,
      captainExpected,
    });
  }

  it('never recommends a chip that is not available', () => {
    const strongBench = Array.from({ length: 4 }, () => projection('DEF', 8));
    const analysis = evaluate(strongBench, []);
    expect(analysis.recommended).toBeNull();
    expect(analysis.evaluations.every((e) => !e.recommended)).toBe(true);
  });

  it('recommends bench boost only once the bench clears its threshold', () => {
    const weak = Array.from({ length: 4 }, () => projection('DEF', 2));
    expect(evaluate(weak, ['bboost']).recommended).toBeNull();

    const strong = Array.from({ length: 4 }, () => projection('DEF', 8));
    expect(evaluate(strong, ['bboost']).recommended).toBe('bboost');
  });

  it('refuses bench boost when a bench player may not feature', () => {
    const withBlank = [
      projection('DEF', 8),
      projection('DEF', 8),
      projection('DEF', 8),
      projection('DEF', 0),
    ];
    const bboost = evaluate(withBlank, ['bboost']).evaluations.find((e) => e.chip === 'bboost');
    expect(bboost?.recommended).toBe(false);
    expect(bboost?.reason).toMatch(/may not play/);
  });

  it('recommends triple captain only for a big captain projection', () => {
    const bench = Array.from({ length: 4 }, () => projection('DEF', 1));
    expect(evaluate(bench, ['3xc'], 4).recommended).toBeNull();
    expect(evaluate(bench, ['3xc'], 12).recommended).toBe('3xc');
  });

  it('reports a value and a threshold for every available chip', () => {
    const bench = Array.from({ length: 4 }, () => projection('DEF', 3));
    const analysis = evaluate(bench, ['bboost', '3xc', 'freehit', 'wildcard']);
    expect(analysis.evaluations).toHaveLength(4);
    for (const e of analysis.evaluations) {
      expect(e.available).toBe(true);
      expect(e.threshold).toBeGreaterThan(0);
      expect(typeof e.value).toBe('number');
      expect(e.reason.length).toBeGreaterThan(0);
    }
  });
});
