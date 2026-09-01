import type { PositionShort } from '@/lib/fpl/types';
import {
  ASSIST_POINTS,
  CLEAN_SHEET_POINTS,
  CONCEDE_PENALTY_POSITIONS,
  DEFCON_POINTS,
  DEFCON_THRESHOLD,
  GOAL_POINTS,
  SAVES_PER_POINT,
} from './scoring';
import { modelMinutes } from './minutes';
import { cleanSheetProbability, fixtureGoals, type TeamRatings } from './strength';
import type {
  FixtureProjection,
  PlayerFixture,
  PlayerProjection,
  PlayerState,
  StatLine,
} from './types';
import { POSITION_PRIORS, type Weights } from './weights';

/**
 * Expected points, built up component by component the way FPL pays out.
 *
 * The previous engine blended past *points* (form, points per game) and scaled
 * them by a single fixture multiplier. That is circular -- past points already
 * contain the fixtures faced -- and it cannot tell a defender's clean-sheet
 * upside from a striker's. Here every scoring route is modelled separately and
 * adjusted by the part of the fixture that actually drives it.
 */

/** Rate per 90 minutes, shrunk toward the position prior when evidence is thin. */
function per90(
  value: number,
  minutes: number,
  prior: number,
  weights: Weights,
  priorMinutes = weights.rateShrinkAppearances * 90,
): number {
  const observed = minutes > 0 ? (value / minutes) * 90 : prior;
  const w = minutes / (minutes + priorMinutes);
  return w * observed + (1 - w) * prior;
}

/** Blend the recent window with the season for a per-90 rate. */
function blendedRate(
  season: StatLine,
  recent: StatLine,
  pick: (s: StatLine) => number,
  prior: number,
  weights: Weights,
): number {
  const seasonRate = per90(pick(season), season.minutes, prior, weights);
  if (recent.minutes <= 0) return seasonRate;
  const recentRate = per90(pick(recent), recent.minutes, prior, weights);
  return weights.recencyWeight * recentRate + (1 - weights.recencyWeight) * seasonRate;
}

/** Poisson tail: probability of at least `k` events given mean `lambda`. */
export function poissonAtLeast(lambda: number, k: number): number {
  if (k <= 0) return 1;
  if (lambda <= 0) return 0;
  let term = Math.exp(-lambda);
  let cumulative = term;
  for (let i = 1; i < k; i++) {
    term = (term * lambda) / i;
    cumulative += term;
  }
  return Math.max(0, Math.min(1, 1 - cumulative));
}

/** Expected value of goals conceded penalty: -1 per two conceded. */
function concedePenalty(expectedConceded: number): number {
  // E[floor(X/2)] for X ~ Poisson, summed over the range that matters.
  let expectation = 0;
  let term = Math.exp(-expectedConceded);
  for (let goals = 0; goals <= 9; goals++) {
    if (goals > 0) term = (term * expectedConceded) / goals;
    expectation += term * Math.floor(goals / 2);
  }
  return -expectation;
}

/** Scoring rules that have changed between seasons. */
export interface SeasonRules {
  /**
   * Defensive contribution points, introduced in 2025/26. Backtests on earlier
   * seasons must switch this off or the engine credits points that could not
   * have been scored.
   */
  defensiveContribution: boolean;
}

export const CURRENT_RULES: SeasonRules = { defensiveContribution: true };

export interface ProjectionContext {
  ratings: TeamRatings;
  weights: Weights;
  /** Average goals a team is expected to score, used to scale player shares. */
  leagueMeanGoals: number;
  rules: SeasonRules;
}

/**
 * Project a single fixture for a single player.
 *
 * Attacking output scales with how many goals the player's team is expected to
 * score; clean sheets and concession scale with what they are expected to let
 * in. Both come from the team ratings, so a striker facing a leaky defence and
 * a defender facing a toothless attack are each rewarded for the right reason.
 */
export function projectFixture(
  player: PlayerState,
  fixture: PlayerFixture,
  ctx: ProjectionContext,
): FixtureProjection {
  const { weights, ratings } = ctx;
  const prior = POSITION_PRIORS[player.position] ?? POSITION_PRIORS.MID;
  const minutes = modelMinutes(player, weights);

  const goals = fixtureGoals(ratings, player.teamId, fixture.opponentId, fixture.isHome, weights);
  const teamScored = goals.scored;
  const teamConceded = goals.conceded;

  // The player's own rates, then tilted by how this fixture differs from an
  // average one for his team.
  const attackScale = teamScored / weights.leagueMeanGoals;

  const xg90 = blendedRate(player.season, player.recent, (s) => s.xg || s.goals, prior.xg90, weights);
  const xa90 = blendedRate(
    player.season,
    player.recent,
    (s) => s.xa || s.assists,
    prior.xa90,
    weights,
  );

  const minuteShare = minutes.expectedMinutes / 90;
  const expectedGoals = xg90 * minuteShare * attackScale;
  const expectedAssists = xa90 * minuteShare * attackScale;

  const csProb = cleanSheetProbability(teamConceded);

  // --- components ---------------------------------------------------------
  const appearance =
    minutes.playProbability * 1 + minutes.sixtyProbability * 1; // 1 for playing, 1 more at 60'

  const goalPoints = expectedGoals * GOAL_POINTS[player.position];
  const assistPoints = expectedAssists * ASSIST_POINTS;

  const cleanSheetPoints =
    CLEAN_SHEET_POINTS[player.position] > 0
      ? CLEAN_SHEET_POINTS[player.position] * csProb * minutes.sixtyProbability
      : 0;

  const concedePoints = CONCEDE_PENALTY_POSITIONS.includes(player.position)
    ? concedePenalty(teamConceded) * minutes.sixtyProbability
    : 0;

  let savePoints = 0;
  if (player.position === 'GKP') {
    const saves90 = blendedRate(player.season, player.recent, (s) => s.saves, prior.saves90, weights);
    // Shots faced rise against stronger attacks, roughly with expected goals.
    const saveRate = saves90 * minuteShare * (teamConceded / weights.leagueMeanGoals);
    savePoints = saveRate / SAVES_PER_POINT;
  }

  const defconPoints = ctx.rules.defensiveContribution
    ? expectedDefconPoints(player, minutes.expectedMinutes, weights)
    : 0;

  const bonus90 = blendedRate(player.season, player.recent, (s) => s.bonus, prior.bonus90, weights);
  const bonusPoints = bonus90 * minuteShare * weights.bonusScale;

  const yellow90 = blendedRate(player.season, player.recent, (s) => s.yellow, prior.yellow90, weights);
  const cardPoints = -(yellow90 * minuteShare);

  const total =
    appearance +
    goalPoints +
    assistPoints +
    cleanSheetPoints +
    concedePoints +
    savePoints +
    defconPoints +
    bonusPoints +
    cardPoints;

  return {
    event: fixture.event,
    opponent: fixture.opponent,
    isHome: fixture.isHome,
    difficulty: fixture.difficulty,
    expectedMinutes: round2(minutes.expectedMinutes),
    playProbability: round3(minutes.playProbability),
    sixtyProbability: round3(minutes.sixtyProbability),
    cleanSheetProbability: round3(csProb),
    points: round2(Math.max(0, total)),
    components: {
      appearance: round2(appearance),
      goals: round2(goalPoints),
      assists: round2(assistPoints),
      cleanSheet: round2(cleanSheetPoints),
      concede: round2(concedePoints),
      saves: round2(savePoints),
      defcon: round2(defconPoints),
      bonus: round2(bonusPoints),
      cards: round2(cardPoints),
    },
  };
}

/**
 * Defensive-contribution points.
 *
 * Prefers the player's observed hit rate -- how often he actually cleared the
 * threshold -- because the tally is bursty and a Poisson assumption on the raw
 * action count understates specialists. Falls back to a Poisson estimate from
 * the per-90 action rate when per-appearance history is unavailable.
 */
export function expectedDefconPoints(
  player: PlayerState,
  expectedMinutes: number,
  weights: Weights,
): number {
  const threshold = DEFCON_THRESHOLD[player.position];
  if (threshold === null) return 0;

  const prior = POSITION_PRIORS[player.position] ?? POSITION_PRIORS.MID;
  const appearances = player.season.appearances;

  let hitRate: number;
  if (appearances >= 3) {
    const observed = player.season.defconHits / appearances;
    // Shrink toward the Poisson estimate so three lucky games do not convince us.
    const modelled = poissonAtLeast(
      per90(player.season.defcon, player.season.minutes, prior.defcon90, weights),
      threshold,
    );
    const w = appearances / (appearances + weights.rateShrinkAppearances);
    hitRate = w * observed + (1 - w) * modelled;
  } else {
    const rate90 = per90(player.season.defcon, player.season.minutes, prior.defcon90, weights);
    hitRate = poissonAtLeast(rate90, threshold);
  }

  // The threshold is per match, so scale by how much of a match he plays.
  const minuteShare = Math.min(1, expectedMinutes / 90);
  return DEFCON_POINTS * hitRate * minuteShare;
}

/**
 * Project a player across every fixture in the horizon.
 *
 * A blank gameweek yields nothing and a double yields two fixtures, both of
 * which fall out naturally because this walks the fixture list.
 */
export function projectPlayer(
  player: PlayerState,
  fixtures: PlayerFixture[],
  ctx: ProjectionContext,
): PlayerProjection {
  const projections = fixtures.map((fx) => projectFixture(player, fx, ctx));
  const { weights } = ctx;

  const nextEvent = fixtures.length > 0 ? Math.min(...fixtures.map((f) => f.event)) : null;
  const next = projections
    .filter((p) => p.event === nextEvent)
    .reduce((sum, p) => sum + p.points, 0);

  let horizon = 0;
  let horizonRaw = 0;
  for (const p of projections) {
    const step = nextEvent === null ? 0 : p.event - nextEvent;
    horizon += p.points * Math.pow(weights.horizonDecay, step);
    horizonRaw += p.points;
  }

  const { ceiling, haulProbability } = estimateUpside(player, projections, ctx);

  return {
    playerId: player.id,
    name: player.name,
    position: player.position,
    teamId: player.teamId,
    price: player.price,
    fixtures: projections,
    next: round2(next),
    horizon: round2(horizon),
    horizonRaw: round2(horizonRaw),
    ceiling: round2(ceiling),
    haulProbability: round3(haulProbability),
    availability: round2(modelMinutes(player, weights).availability),
  };
}

/**
 * Captaincy is not about the mean.
 *
 * Two players projected at six points are not equivalent if one gets there via
 * a high chance of a goal and the other via appearance points and a clean
 * sheet. This estimates the probability of a double-digit haul and a rough
 * 90th-percentile outcome, both driven by expected goal involvements.
 */
function estimateUpside(
  player: PlayerState,
  projections: FixtureProjection[],
  ctx: ProjectionContext,
): { ceiling: number; haulProbability: number } {
  const nextEvent = projections.length > 0 ? Math.min(...projections.map((p) => p.event)) : null;
  const next = projections.filter((p) => p.event === nextEvent);
  if (next.length === 0) return { ceiling: 0, haulProbability: 0 };

  const base = next.reduce((sum, p) => sum + p.points, 0);
  const goalPoints = GOAL_POINTS[player.position];

  // Expected involvements implied by the goal and assist components.
  const expectedGoals = next.reduce((s, p) => s + p.components.goals / goalPoints, 0);
  const expectedAssists = next.reduce((s, p) => s + p.components.assists / 3, 0);
  const involvements = expectedGoals + expectedAssists;

  // A haul needs two returns, or one return plus bonus and a clean sheet.
  const twoPlus = poissonAtLeast(involvements, 2);
  const onePlus = poissonAtLeast(involvements, 1);
  const csProb = next.reduce((s, p) => s + p.cleanSheetProbability, 0) / next.length;

  const haulProbability =
    player.position === 'DEF' || player.position === 'GKP'
      ? Math.min(1, twoPlus + onePlus * csProb * 0.45)
      : Math.min(1, twoPlus + onePlus * 0.12);

  // Ceiling: the base outcome plus roughly one extra return's worth of points,
  // weighted by how likely a return actually is.
  const returnValue = (goalPoints + ASSIST_POINTS) / 2;
  const ceiling = base + onePlus * returnValue + twoPlus * returnValue * 0.8;

  return { ceiling, haulProbability };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
