import type { PlayerState } from './types';
import type { Weights } from './weights';

/**
 * Expected minutes.
 *
 * This is the highest-leverage part of the projection: a brilliant player who
 * does not start is worth close to nothing, and most bad transfer advice comes
 * from projecting a rotation risk as though he plays ninety minutes.
 */

export interface MinutesModel {
  /** Probability of getting on the pitch at all. */
  playProbability: number;
  /** Probability of starting. */
  startProbability: number;
  /** Probability of still being on at the hour, which gates clean-sheet points. */
  sixtyProbability: number;
  /** Expected minutes played. */
  expectedMinutes: number;
  /** Injury/suspension multiplier applied on top of the rotation model. */
  availability: number;
}

/**
 * How likely the player is to be fit and selectable.
 *
 * FPL publishes an explicit chance of playing when a player is doubtful; when
 * it is absent the status flag is the only signal.
 */
export function availabilityFactor(player: PlayerState): number {
  if (player.chanceOfPlaying !== null && player.chanceOfPlaying !== undefined) {
    return Math.max(0, Math.min(1, player.chanceOfPlaying / 100));
  }
  switch (player.status) {
    case 'a':
      return 1;
    case 'd':
      return 0.5;
    case 'i':
    case 's':
    case 'u':
    case 'n':
      return 0;
    default:
      return 1;
  }
}

/**
 * Blend a recent-window rate with a season-long rate.
 *
 * Recent form dominates for rotation questions, but a three-game window is
 * noisy, so the season rate anchors it. When there is no recent window at all
 * (start of season) this degrades to the season rate.
 */
function blendRate(
  recentValue: number,
  recentGames: number,
  seasonValue: number,
  seasonGames: number,
  weights: Weights,
): number {
  if (recentGames <= 0) return seasonGames > 0 ? seasonValue : 0;
  if (seasonGames <= 0) return recentValue;
  const w = weights.recencyWeight;
  return w * recentValue + (1 - w) * seasonValue;
}

/**
 * Weighted-count estimate of how often a player is selected.
 *
 * Recent games carry more weight than older ones, and a prior worth a game or
 * two keeps a two-appearance sample from reading as a nailed starter. The same
 * shrinkage pulls a player who has stopped being picked down toward zero,
 * which is where most wasted projection lives.
 */
function selectionRate(
  recentCount: number,
  recentGames: number,
  seasonCount: number,
  seasonGames: number,
  weights: Weights,
): number {
  // With no recent window at all, season evidence is all there is. Weighting it
  // down would shrink a nailed starter toward the prior for no reason.
  if (recentGames <= 0) {
    const denominator = seasonGames + weights.startPriorStrength;
    if (denominator <= 0) return weights.startPrior;
    return Math.max(
      0,
      Math.min(1, (seasonCount + weights.startPrior * weights.startPriorStrength) / denominator),
    );
  }

  const wr = weights.minutesRecencyWeight;
  const ws = 1 - wr;

  // Older games are the season total minus the recent window.
  const olderCount = Math.max(0, seasonCount - recentCount);
  const olderGames = Math.max(0, seasonGames - recentGames);

  const numerator =
    wr * recentCount + ws * olderCount + weights.startPrior * weights.startPriorStrength;
  const denominator = wr * recentGames + ws * olderGames + weights.startPriorStrength;

  if (denominator <= 0) return weights.startPrior;
  return Math.max(0, Math.min(1, numerator / denominator));
}

export function modelMinutes(player: PlayerState, weights: Weights): MinutesModel {
  const availability = availabilityFactor(player);

  const seasonGames = Math.max(0, player.teamGames);
  const recentGames = Math.max(0, player.recent.games);

  // A player with no minutes at all is treated as a non-starter rather than
  // as unknown -- unknown would let a never-used squad player look startable.
  if (seasonGames === 0) {
    return {
      playProbability: availability * 0.5,
      startProbability: availability * 0.4,
      sixtyProbability: availability * 0.35,
      expectedMinutes: availability * 45,
      availability,
    };
  }

  // Selection is estimated as a weighted count, so recent evidence dominates
  // and a thin sample is pulled toward the prior rather than toward 1.0.
  const startRate = selectionRate(
    player.recent.starts,
    recentGames,
    player.season.starts,
    seasonGames,
    weights,
  );
  const playRate = selectionRate(
    player.recent.appearances,
    recentGames,
    player.season.appearances,
    seasonGames,
    weights,
  );

  const startProbability = Math.max(0, Math.min(1, startRate));
  // Appearing is at least as likely as starting.
  const playProbability = Math.max(startProbability, Math.min(1, playRate));
  const benchProbability = Math.max(0, playProbability - startProbability);

  // Minutes per start, measured rather than assumed, so a habitual 60-minute
  // substitution shows up as a lower clean-sheet probability.
  const minutesPerStart =
    player.season.starts > 0
      ? Math.min(weights.fullMatchMinutes, player.season.minutes / player.season.starts)
      : weights.starterMinutes;

  const expectedMinutes =
    availability * (startProbability * minutesPerStart + benchProbability * weights.benchMinutes);

  // Reaching the hour requires starting and not being withdrawn early. Scale
  // the base survival rate by how close this player's starts run to full time.
  const survives =
    weights.starterSurvivesToHour *
    Math.min(1, minutesPerStart / Math.max(1, weights.starterMinutes));

  return {
    playProbability: availability * playProbability,
    startProbability: availability * startProbability,
    sixtyProbability: availability * startProbability * survives,
    expectedMinutes,
    availability,
  };
}

/** Convenience: is this player a plausible starter worth transferring in? */
export function isPlayableStarter(model: MinutesModel): boolean {
  return model.startProbability >= 0.5 && model.availability > 0.5;
}
