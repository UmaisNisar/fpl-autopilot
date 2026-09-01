/**
 * Display-only projection.
 *
 * DECISIONS NO LONGER USE THIS. Everything that matters -- transfers, lineup,
 * captaincy, chips -- runs through `src/lib/engine`, which models each scoring
 * route separately and is walk-forward backtested against past seasons.
 *
 * What remains here feeds the pitch: an ordering for player cards and a
 * last-resort lineup if the engine itself cannot be reached. Keeping it small
 * and separate stops it drifting back into the decision path.
 *
 * The backtest keeps a faithful copy of this model as the "engine v1" baseline,
 * so the improvement over it stays measurable.
 */

import type { FplElement } from '@/lib/fpl/types';
import type { FixtureLite } from '@/lib/fpl/model';

/** How many gameweeks ahead we plan for. */
export const HORIZON = 5;

/** Difficulty 1 (easiest) .. 5 (hardest) -> points multiplier. */
const FDR_MULTIPLIER: Record<number, number> = {
  1: 1.25,
  2: 1.12,
  3: 1.0,
  4: 0.88,
  5: 0.75,
};

export function fdrMultiplier(difficulty: number): number {
  return FDR_MULTIPLIER[difficulty] ?? 1.0;
}

/** 0 = certain to miss, 1 = fully fit. */
export function availabilityFactor(el: FplElement): number {
  const chance = el.chance_of_playing_next_round;
  if (chance !== null && chance !== undefined) return chance / 100;
  switch (el.status) {
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

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : parseFloat(v ?? '0');
  return Number.isFinite(n) ? n : 0;
};

/**
 * Blended baseline points per appearance, weighting recent form, season-long
 * consistency and FPL's own expected-points figure.
 */
export function baselinePerGame(el: FplElement): number {
  const form = num(el.form);
  const ppg = num(el.points_per_game);
  const ep = num(el.ep_next);

  const parts: { value: number; weight: number }[] = [];
  if (form > 0) parts.push({ value: form, weight: 0.4 });
  if (ppg > 0) parts.push({ value: ppg, weight: 0.3 });
  if (ep > 0) parts.push({ value: ep, weight: 0.3 });

  if (parts.length === 0) return 0;
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  return parts.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight;
}

/**
 * Share of the team's gameweeks the player actually started. Punishes rotation
 * risk and cameo-only players without needing minutes-prediction data.
 */
export function startShare(el: FplElement, gamesPlayed: number): number {
  if (gamesPlayed <= 0) return el.minutes > 0 ? 1 : 0.5;
  return Math.min(1, el.starts / gamesPlayed);
}

export interface ProjectionInput {
  element: FplElement;
  fixtures: FixtureLite[];
  gamesPlayed: number;
}

export interface Projection {
  /** Expected points across the whole horizon. */
  total: number;
  /** Expected points for the next gameweek only. */
  next: number;
  /** Mean fixture difficulty across the horizon (3 when there are no games). */
  fdr: number;
}

export function project({ element, fixtures, gamesPlayed }: ProjectionInput): Projection {
  const base = baselinePerGame(element);
  const availability = availabilityFactor(element);
  const minutes = startShare(element, gamesPlayed);
  const perMatch = base * availability * (0.55 + 0.45 * minutes);

  let total = 0;
  let next = 0;
  const nextEvent = fixtures.length > 0 ? fixtures[0].event : null;

  for (const f of fixtures) {
    // Small home advantage on top of the difficulty rating.
    const value = perMatch * fdrMultiplier(f.difficulty) * (f.isHome ? 1.03 : 0.97);
    total += value;
    if (f.event === nextEvent) next += value;
  }

  const fdr =
    fixtures.length > 0
      ? fixtures.reduce((s, f) => s + f.difficulty, 0) / fixtures.length
      : 3;

  return {
    total: round1(total),
    next: round1(next),
    fdr: Math.round(fdr * 10) / 10,
  };
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
