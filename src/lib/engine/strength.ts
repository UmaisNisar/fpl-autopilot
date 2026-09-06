import type { FixtureState, TeamState } from './types';
import type { Weights } from './weights';

/**
 * Multiplicative team ratings, in the style of a Dixon-Coles goals model.
 *
 * A fixture's expected goals are `leagueMean * attack[scorer] * concede[defender]
 * * homeAdvantage`, with every rating centred on 1.0. Ratings come from results
 * so far, shrunk toward a prior derived from FPL's own difficulty ratings --
 * which matters enormously in August, when two matches of evidence would
 * otherwise put a team at triple the league average.
 */

export interface TeamRatings {
  /** How many goals this team scores relative to average. */
  attack: Map<number, number>;
  /** How many goals this team concedes relative to average. */
  concede: Map<number, number>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * FPL difficulty is assigned to the side *facing* a team, so the difficulties
 * stamped on a team's opponents measure that team's strength. Averaging them
 * gives a strength prior that is available from the very first gameweek.
 *
 * Returns a value on the FPL 1-5 scale for each team.
 */
export function difficultyPrior(fixtures: FixtureState[], teams: TeamState[]): Map<number, number> {
  const totals = new Map<number, { sum: number; count: number }>();

  const add = (teamId: number, difficulty: number) => {
    const entry = totals.get(teamId) ?? { sum: 0, count: 0 };
    entry.sum += difficulty;
    entry.count += 1;
    totals.set(teamId, entry);
  };

  for (const fx of fixtures) {
    // difficultyH is what the home side faces, i.e. how hard the away side is.
    add(fx.teamA, fx.difficultyH);
    add(fx.teamH, fx.difficultyA);
  }

  const prior = new Map<number, number>();
  for (const team of teams) {
    const entry = totals.get(team.id);
    prior.set(team.id, entry && entry.count > 0 ? entry.sum / entry.count : 3);
  }
  return prior;
}

/**
 * Map an FPL difficulty rating to a goals multiplier. Difficulty 5 sides score
 * more and concede less; difficulty 2 sides do the opposite. The spread is
 * deliberately modest because this is only a prior.
 */
function priorRatings(difficulty: number): { attack: number; concede: number } {
  // Centre on 3, which is a league-average side.
  const delta = difficulty - 3;
  return {
    attack: 1 + delta * 0.16,
    concede: 1 - delta * 0.15,
  };
}

/**
 * Blend results-so-far with the difficulty prior.
 *
 * Uses expected goals when the season has produced them, because xG stabilises
 * much faster than goals do -- exactly the property that matters when there are
 * only a handful of matches on the board.
 */
export function computeTeamRatings(
  teams: TeamState[],
  allFixtures: FixtureState[],
  weights: Weights,
): TeamRatings {
  const prior = difficultyPrior(allFixtures, teams);

  const played = teams.reduce((sum, t) => sum + t.played, 0);
  const totalGoals = teams.reduce((sum, t) => sum + t.goalsFor, 0);
  const leagueMean = played > 0 ? totalGoals / played : weights.leagueMeanGoals;
  const safeMean = leagueMean > 0.4 ? leagueMean : weights.leagueMeanGoals;

  const totalXgFor = teams.reduce((sum, t) => sum + t.xgFor, 0);
  const useXg = totalXgFor > 0;
  const leagueMeanXg = useXg && played > 0 ? totalXgFor / played : safeMean;

  const attack = new Map<number, number>();
  const concede = new Map<number, number>();

  for (const team of teams) {
    const p = priorRatings(prior.get(team.id) ?? 3);
    const n = team.played;
    const k = weights.strengthShrinkGames;

    if (n === 0) {
      attack.set(team.id, clamp(p.attack, weights.ratingFloor, weights.ratingCeiling));
      concede.set(team.id, clamp(p.concede, weights.ratingFloor, weights.ratingCeiling));
      continue;
    }

    // xG is the better signal; fall back to goals when it is unavailable.
    const scoredPerGame = useXg ? team.xgFor / n : team.goalsFor / n;
    const concededPerGame = useXg && team.xgAgainst > 0 ? team.xgAgainst / n : team.goalsAgainst / n;
    const mean = useXg ? leagueMeanXg : safeMean;

    const empiricalAttack = scoredPerGame / mean;
    const empiricalConcede = concededPerGame / mean;

    attack.set(
      team.id,
      clamp((n * empiricalAttack + k * p.attack) / (n + k), weights.ratingFloor, weights.ratingCeiling),
    );
    concede.set(
      team.id,
      clamp(
        (n * empiricalConcede + k * p.concede) / (n + k),
        weights.ratingFloor,
        weights.ratingCeiling,
      ),
    );
  }

  settle(attack, weights);
  settle(concede, weights);

  return { attack, concede };
}

/**
 * Re-centre on 1.0 and hold the clamp.
 *
 * Order matters: clamping before normalising does not work, because dividing
 * by the mean pushes values straight back past the ceiling -- a two-match
 * sample once came out at 1.92 against a cap of 1.75. Alternating the two
 * converges in a couple of passes, and the clamps rarely bind at all once a
 * season is under way.
 */
function settle(ratings: Map<number, number>, weights: Weights) {
  for (let pass = 0; pass < 4; pass++) {
    const values = [...ratings.values()];
    if (values.length === 0) return;

    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    if (mean <= 0) return;

    let clamped = false;
    for (const [id, value] of ratings) {
      const centred = value / mean;
      const bounded = clamp(centred, weights.ratingFloor, weights.ratingCeiling);
      if (bounded !== centred) clamped = true;
      ratings.set(id, bounded);
    }

    if (!clamped) return;
  }
}

/** Expected goals for each side of a fixture. */
export function fixtureGoals(
  ratings: TeamRatings,
  teamId: number,
  opponentId: number,
  isHome: boolean,
  weights: Weights,
): { scored: number; conceded: number } {
  const atk = ratings.attack.get(teamId) ?? 1;
  const oppAtk = ratings.attack.get(opponentId) ?? 1;
  const def = ratings.concede.get(teamId) ?? 1;
  const oppDef = ratings.concede.get(opponentId) ?? 1;

  const home = weights.homeAdvantage;
  const mean = weights.leagueMeanGoals;

  return {
    scored: mean * atk * oppDef * (isHome ? home : 1 / home),
    conceded: mean * oppAtk * def * (isHome ? 1 / home : home),
  };
}

/** Poisson probability of zero goals, i.e. a clean sheet. */
export function cleanSheetProbability(expectedConceded: number): number {
  return Math.exp(-Math.max(0, expectedConceded));
}
