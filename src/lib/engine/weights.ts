/**
 * Every tunable number in the decision engine, in one place.
 *
 * Nothing else in `engine/` may hard-code a coefficient. Backtests load a
 * weight set, run the season, and record the result against ENGINE_VERSION, so
 * a change is only accepted when the out-of-sample numbers say it helped.
 *
 * Bump ENGINE_VERSION whenever any value here changes.
 */

export const ENGINE_VERSION = '2.2.0';

export interface Weights {
  /** Games of evidence before empirical team ratings outweigh the FDR prior. */
  strengthShrinkGames: number;
  /** Goals a league-average team scores per match. */
  leagueMeanGoals: number;
  /** Multiplier applied to the home side's expected goals. */
  homeAdvantage: number;
  /** Clamp on team attack/defence ratings, to stop small samples running away. */
  ratingFloor: number;
  ratingCeiling: number;

  /** Weight on the recent window versus season-long rates, for scoring rates. */
  recencyWeight: number;
  /**
   * Weight on the recent window for selection. Higher than `recencyWeight`
   * because who starts is far more autocorrelated than how many goals they
   * score -- a player dropped for three weeks is usually still dropped.
   */
  minutesRecencyWeight: number;
  /** Prior probability that an unknown squad player starts. */
  startPrior: number;
  /** Games of evidence the start prior is worth. */
  startPriorStrength: number;
  /** How many gameweeks count as "recent". */
  recentWindow: number;
  /** Appearances of evidence before a player's own rates outweigh position priors. */
  rateShrinkAppearances: number;
  /**
   * How much last season counts, as a fraction of its actual minutes.
   *
   * Measured at zero. A full previous season shifted rank correlation by
   * 0.001 and calibration by 0.008 -- indistinguishable from nothing. The
   * plumbing is kept because it is what produced that measurement, and the
   * switch makes it a one-line experiment to revisit.
   */
  previousSeasonWeight: number;
  /**
   * Extra prior strength granted when last season's start rate is known.
   *
   * Measured at zero. It does fix calibration -- bias moves from -0.402 to
   * -0.139 -- but pays for it with 0.043 of rank correlation and 0.15 points
   * per top-20 pick, because a player's role moves between seasons and last
   * year's start rate blurs who is being picked now. The calibration layer
   * below buys the same correction while preserving order, which is strictly
   * the better trade.
   */
  previousStartWeight: number;

  /** Minutes assumed for a player who starts and is not substituted. */
  fullMatchMinutes: number;
  /** Typical minutes for a starter across all outcomes. */
  starterMinutes: number;
  /** Typical minutes for someone coming off the bench. */
  benchMinutes: number;
  /** Probability a starter is still on at 60 minutes. */
  starterSurvivesToHour: number;

  /** Share of a team's goals converted into assists by team-mates. */
  assistShare: number;
  /** Bonus points regression: how strongly BPS rate maps to bonus. */
  bonusScale: number;

  /**
   * Rank-preserving calibration, applied to every fixture projection as
   * `intercept + slope * raw`.
   *
   * The raw model systematically under-calls: a projection of 5.4 was worth
   * 6.5 in reality. An affine rescale fixes the level without touching the
   * order, so ranking -- which is what transfer and captain decisions turn on
   * -- is untouched while the numbers on screen and the fixed chip thresholds
   * become meaningful. Fitted on the training split only.
   */
  calibrationSlope: number;
  calibrationIntercept: number;

  /** Points discount applied to each successive gameweek in the horizon. */
  horizonDecay: number;
  /** Gameweeks the engine plans over. */
  horizon: number;

  /**
   * The four weights below convert a projection into an action, and unlike the
   * projection weights they have no statistical proxy -- the only honest
   * objective is points actually scored. They are fitted by
   * `npm run tune:decisions`, which optimises a full season simulation on one
   * season and validates on the other. Doing that was worth +146 points across
   * the held-out season.
   */

  /** Points a banked free transfer is worth as future flexibility. */
  freeTransferValue: number;
  /** Extra expected points a transfer must clear before it is worth doing. */
  transferThreshold: number;
  /** Extra expected points a hit must clear beyond its 4-point cost. */
  hitThreshold: number;

  /** Weight on captaincy upside versus flat expectation. */
  captainUpsideWeight: number;

  /** Bench Boost is only worth it above this projected bench total. */
  benchBoostThreshold: number;
  /** Triple Captain needs the captain projected above this. */
  tripleCaptainThreshold: number;
  /** Free Hit needs this many expected points of gain in the week. */
  freeHitThreshold: number;
  /** Wildcard needs this much gain across the horizon. */
  wildcardThreshold: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  strengthShrinkGames: 3,
  leagueMeanGoals: 1.42,
  homeAdvantage: 1.12,
  ratingFloor: 0.55,
  ratingCeiling: 1.75,

  recencyWeight: 0.6,
  minutesRecencyWeight: 0.9,
  startPrior: 0.05,
  startPriorStrength: 1.5,
  recentWindow: 5,
  rateShrinkAppearances: 8,
  previousSeasonWeight: 0,
  previousStartWeight: 0,

  fullMatchMinutes: 90,
  starterMinutes: 78,
  benchMinutes: 18,
  starterSurvivesToHour: 0.88,

  assistShare: 0.72,
  bonusScale: 0.7,

  calibrationSlope: 1.1906,
  calibrationIntercept: 0.1677,

  horizonDecay: 0.7,
  horizon: 5,

  freeTransferValue: 2.5,
  transferThreshold: 0,
  hitThreshold: 0,

  captainUpsideWeight: 1.1,

  benchBoostThreshold: 16,
  tripleCaptainThreshold: 8.5,
  freeHitThreshold: 14,
  wildcardThreshold: 22,
};

/** Per-position priors used to shrink thin samples toward something sane. */
export interface PositionPrior {
  /** Expected goals per 90 for a nominal starter. */
  xg90: number;
  /** Expected assists per 90. */
  xa90: number;
  /** Defensive actions per 90, for the defensive-contribution bonus. */
  defcon90: number;
  /** Bonus points per 90. */
  bonus90: number;
  /** Saves per 90 (goalkeepers only). */
  saves90: number;
  /** Yellow cards per 90. */
  yellow90: number;
}

export const POSITION_PRIORS: Record<string, PositionPrior> = {
  GKP: { xg90: 0.0, xa90: 0.01, defcon90: 0, bonus90: 0.28, saves90: 3.0, yellow90: 0.05 },
  DEF: { xg90: 0.05, xa90: 0.06, defcon90: 6.4, bonus90: 0.3, saves90: 0, yellow90: 0.16 },
  MID: { xg90: 0.14, xa90: 0.13, defcon90: 6.9, bonus90: 0.32, saves90: 0, yellow90: 0.15 },
  FWD: { xg90: 0.36, xa90: 0.13, defcon90: 3.6, bonus90: 0.38, saves90: 0, yellow90: 0.12 },
};
