import type { PositionShort } from '@/lib/fpl/types';

/**
 * FPL scoring rules, as executable data.
 *
 * These are verified against a full real season by
 * `npm run verify:scoring` -- if FPL changes the rules, that test fails
 * rather than the engine quietly drifting.
 */

export const GOAL_POINTS: Record<PositionShort, number> = {
  GKP: 6,
  DEF: 6,
  MID: 5,
  FWD: 4,
};

export const ASSIST_POINTS = 3;

export const CLEAN_SHEET_POINTS: Record<PositionShort, number> = {
  GKP: 4,
  DEF: 4,
  MID: 1,
  FWD: 0,
};

/** Positions that lose a point for every two goals their team concedes. */
export const CONCEDE_PENALTY_POSITIONS: PositionShort[] = ['GKP', 'DEF'];

/**
 * Defensive contribution, introduced in 2025/26. A player banking enough
 * defensive actions in a match earns a flat 2 points.
 *
 * The underlying tally differs by position: defenders count clearances,
 * blocks, interceptions and tackles; everyone else also counts recoveries.
 * Goalkeepers are not eligible.
 */
export const DEFCON_THRESHOLD: Record<PositionShort, number | null> = {
  GKP: null,
  DEF: 10,
  MID: 12,
  FWD: 12,
};

export const DEFCON_POINTS = 2;

export const APPEARANCE_POINTS = 1;
export const FULL_APPEARANCE_MINUTES = 60;
export const FULL_APPEARANCE_POINTS = 2;

export const SAVES_PER_POINT = 3;
export const PENALTY_SAVE_POINTS = 5;
export const PENALTY_MISS_POINTS = -2;
export const YELLOW_CARD_POINTS = -1;
export const RED_CARD_POINTS = -3;
export const OWN_GOAL_POINTS = -2;

/** A single match performance, in the terms FPL scores. */
export interface Performance {
  minutes: number;
  goals: number;
  assists: number;
  cleanSheet: boolean;
  goalsConceded: number;
  saves: number;
  penaltiesSaved: number;
  penaltiesMissed: number;
  yellowCards: number;
  redCards: number;
  ownGoals: number;
  bonus: number;
  /** Raw defensive-action tally, not the points awarded for it. */
  defensiveContribution: number;
}

/** Exact FPL points for one appearance. */
export function scorePerformance(position: PositionShort, p: Performance): number {
  if (p.minutes <= 0) return 0;

  let points =
    p.minutes >= FULL_APPEARANCE_MINUTES ? FULL_APPEARANCE_POINTS : APPEARANCE_POINTS;

  points += p.goals * GOAL_POINTS[position];
  points += p.assists * ASSIST_POINTS;

  // A clean sheet only counts for a player who saw out an hour.
  if (p.cleanSheet && p.minutes >= FULL_APPEARANCE_MINUTES) {
    points += CLEAN_SHEET_POINTS[position];
  }

  if (position === 'GKP') points += Math.floor(p.saves / SAVES_PER_POINT);

  if (CONCEDE_PENALTY_POSITIONS.includes(position)) {
    points -= Math.floor(p.goalsConceded / 2);
  }

  const threshold = DEFCON_THRESHOLD[position];
  if (threshold !== null && p.defensiveContribution >= threshold) {
    points += DEFCON_POINTS;
  }

  points += p.penaltiesSaved * PENALTY_SAVE_POINTS;
  points += p.penaltiesMissed * PENALTY_MISS_POINTS;
  points += p.yellowCards * YELLOW_CARD_POINTS;
  points += p.redCards * RED_CARD_POINTS;
  points += p.ownGoals * OWN_GOAL_POINTS;
  points += p.bonus;

  return points;
}

/** Points a captain adds on top of the base score. */
export function captainMultiplier(tripleCaptain: boolean): number {
  return tripleCaptain ? 3 : 2;
}

export const TRANSFER_HIT_COST = 4;
