import type { PlayerState, WorldState } from '../../src/lib/engine/types';
import type { Weights } from '../../src/lib/engine/weights';

/**
 * Honest baselines.
 *
 * FPL's published `xP` column is deliberately NOT used. It looks like a
 * pre-deadline forecast but 64% of players who did not feature carry an xP of
 * exactly zero, which no genuine forecast could know -- the historical scraper
 * snapshots it after the gameweek. Measuring against it would flatter or
 * punish the engine for the wrong reasons.
 *
 * What is left are baselines that can only see the past:
 *
 *  - `weekMean`     the population average, the floor any model must clear
 *  - `seasonPpg`    points per gameweek so far
 *  - `recentForm`   mean points over the recent window
 *  - `legacyV1`     a faithful rebuild of the engine this one replaced
 */

export type Baseline = (player: PlayerState, world: WorldState, weights: Weights) => number;

export const seasonPpg: Baseline = (player) => {
  if (player.season.games === 0) return 0;
  return player.season.points / player.season.games;
};

export const recentForm: Baseline = (player) => {
  if (player.recent.games === 0) return seasonPpg(player, {} as WorldState, {} as Weights);
  return player.recent.points / player.recent.games;
};

/** Difficulty multiplier used by the original engine. */
const LEGACY_FDR: Record<number, number> = { 1: 1.25, 2: 1.12, 3: 1.0, 4: 0.88, 5: 0.75 };

/**
 * The engine as it was before this rework: a weighted blend of recent form and
 * season points per game, scaled by a single fixture-difficulty multiplier and
 * a crude minutes factor.
 *
 * `ep_next` was the third term in the original blend. It is dropped here
 * because the historical equivalent is the leaking column, so this is the old
 * engine's shape reproduced from data that was genuinely available.
 */
export function legacyV1(player: PlayerState, world: WorldState, weights: Weights): number {
  const form = player.recent.games > 0 ? player.recent.points / player.recent.games : 0;
  const ppg = player.season.games > 0 ? player.season.points / player.season.games : 0;

  const parts: { value: number; weight: number }[] = [];
  if (form > 0) parts.push({ value: form, weight: 0.4 });
  if (ppg > 0) parts.push({ value: ppg, weight: 0.3 });
  if (parts.length === 0) return 0;

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const base = parts.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight;

  const availability = player.status === 'a' ? 1 : player.status === 'd' ? 0.5 : 0;
  const startShare =
    player.teamGames > 0 ? Math.min(1, player.season.starts / player.teamGames) : 0.5;
  const perMatch = base * availability * (0.55 + 0.45 * startShare);

  const fixtures = world.fixtures.filter(
    (f) => f.event === world.event && (f.teamH === player.teamId || f.teamA === player.teamId),
  );

  let total = 0;
  for (const fixture of fixtures) {
    const isHome = fixture.teamH === player.teamId;
    const difficulty = isHome ? fixture.difficultyH : fixture.difficultyA;
    total += perMatch * (LEGACY_FDR[difficulty] ?? 1) * (isHome ? 1.03 : 0.97);
  }
  return total;
}

export const BASELINES: { name: string; fn: Baseline }[] = [
  { name: 'season ppg', fn: seasonPpg },
  { name: 'recent form', fn: recentForm },
  { name: 'engine v1', fn: legacyV1 },
];

/**
 * Wrap the legacy model in the engine's projection shape.
 *
 * This lets the backtest push v1's numbers through the current transfer,
 * lineup and captaincy machinery, so the resulting difference is attributable
 * to the projections alone rather than to everything else that changed.
 */
export function legacyProjections(
  world: WorldState,
  weights: Weights,
): Map<number, import('../../src/lib/engine/types').PlayerProjection> {
  const shortName = new Map(world.teams.map((t) => [t.id, t.shortName]));
  const out = new Map<number, import('../../src/lib/engine/types').PlayerProjection>();
  const lastEvent = world.event + weights.horizon - 1;

  for (const player of world.players) {
    const fixtures = world.fixtures.filter(
      (f) =>
        !f.finished &&
        f.event >= world.event &&
        f.event <= lastEvent &&
        (f.teamH === player.teamId || f.teamA === player.teamId),
    );

    const projected = fixtures.map((f) => {
      const isHome = f.teamH === player.teamId;
      const difficulty = isHome ? f.difficultyH : f.difficultyA;
      // Reuse the legacy per-fixture value by evaluating it against a world
      // whose "current" event is this fixture's event.
      const points = legacyV1(player, { ...world, event: f.event }, weights);
      return {
        event: f.event,
        opponent: shortName.get(isHome ? f.teamA : f.teamH) ?? '???',
        isHome,
        difficulty,
        expectedMinutes: 0,
        playProbability: 0,
        sixtyProbability: 0,
        cleanSheetProbability: 0,
        points: fixtures.filter((x) => x.event === f.event).length > 1 ? points / 2 : points,
        components: {
          appearance: 0,
          goals: 0,
          assists: 0,
          cleanSheet: 0,
          concede: 0,
          saves: 0,
          defcon: 0,
          bonus: 0,
          cards: 0,
        },
      };
    });

    const next = projected
      .filter((p) => p.event === world.event)
      .reduce((s, p) => s + p.points, 0);
    const horizon = projected.reduce(
      (s, p) => s + p.points * Math.pow(weights.horizonDecay, p.event - world.event),
      0,
    );

    out.set(player.id, {
      playerId: player.id,
      name: player.name,
      position: player.position,
      teamId: player.teamId,
      price: player.price,
      fixtures: projected,
      next,
      horizon,
      horizonRaw: projected.reduce((s, p) => s + p.points, 0),
      ceiling: next * 1.6,
      haulProbability: 0,
      availability: player.status === 'a' ? 1 : 0.5,
    });
  }

  return out;
}
