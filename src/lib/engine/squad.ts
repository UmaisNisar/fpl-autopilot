import type { PositionShort } from '@/lib/fpl/types';
import type { PlayerProjection } from './types';
import type { Weights } from './weights';

/**
 * Squad-level evaluation.
 *
 * A transfer is worth making only if it improves the points you actually score,
 * and you only score your starting eleven. Evaluating swaps on raw player
 * projections would rate an upgrade to a benchwarmer as highly as an upgrade to
 * a starter, so everything here works through the best legal XI.
 */

const SQUAD_SHAPE: Record<PositionShort, number> = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
const POSITIONS: PositionShort[] = ['GKP', 'DEF', 'MID', 'FWD'];

/** Every legal outfield split: 3-5 DEF, 2-5 MID, 1-3 FWD. */
const FORMATIONS: { def: number; mid: number; fwd: number }[] = (() => {
  const out: { def: number; mid: number; fwd: number }[] = [];
  for (let def = 3; def <= 5; def++) {
    for (let mid = 2; mid <= 5; mid++) {
      const fwd = 10 - def - mid;
      if (fwd >= 1 && fwd <= 3) out.push({ def, mid, fwd });
    }
  }
  return out;
})();

/** Points each player is projected for in a given gameweek. */
export type EventPoints = Map<number, Map<number, number>>;

export function buildEventPoints(projections: PlayerProjection[]): EventPoints {
  const index: EventPoints = new Map();
  for (const projection of projections) {
    const byEvent = new Map<number, number>();
    for (const fixture of projection.fixtures) {
      byEvent.set(fixture.event, (byEvent.get(fixture.event) ?? 0) + fixture.points);
    }
    index.set(projection.playerId, byEvent);
  }
  return index;
}

export function pointsFor(index: EventPoints, playerId: number, event: number): number {
  return index.get(playerId)?.get(event) ?? 0;
}

export interface BestEleven {
  starters: PlayerProjection[];
  bench: PlayerProjection[];
  formation: string;
  /** Total expected points of the eleven, captain not included. */
  total: number;
}

/**
 * Highest-scoring legal XI for one gameweek. Exhaustive over the fourteen legal
 * formations, so it cannot return something the game would reject.
 */
export function bestEleven(
  squad: PlayerProjection[],
  event: number,
  index: EventPoints,
): BestEleven {
  const score = (p: PlayerProjection) => pointsFor(index, p.playerId, event);

  const byPosition = new Map<PositionShort, PlayerProjection[]>();
  for (const pos of POSITIONS) {
    byPosition.set(
      pos,
      squad.filter((p) => p.position === pos).sort((a, b) => score(b) - score(a)),
    );
  }

  const keepers = byPosition.get('GKP') ?? [];
  const defenders = byPosition.get('DEF') ?? [];
  const midfielders = byPosition.get('MID') ?? [];
  const forwards = byPosition.get('FWD') ?? [];

  let best: { starters: PlayerProjection[]; total: number; shape: string } | null = null;

  for (const shape of FORMATIONS) {
    if (
      keepers.length < 1 ||
      defenders.length < shape.def ||
      midfielders.length < shape.mid ||
      forwards.length < shape.fwd
    ) {
      continue;
    }

    const starters = [
      keepers[0],
      ...defenders.slice(0, shape.def),
      ...midfielders.slice(0, shape.mid),
      ...forwards.slice(0, shape.fwd),
    ];
    const total = starters.reduce((sum, p) => sum + score(p), 0);
    if (!best || total > best.total) {
      best = { starters, total, shape: `${shape.def}-${shape.mid}-${shape.fwd}` };
    }
  }

  const starters = best?.starters ?? squad.slice(0, 11);
  const starterIds = new Set(starters.map((p) => p.playerId));
  const remaining = squad.filter((p) => !starterIds.has(p.playerId));

  return {
    starters,
    bench: orderBench(remaining, score),
    formation: best?.shape ?? '0-0-0',
    total: best?.total ?? 0,
  };
}

/** Reserve keeper first, then outfield substitutes in the order they come on. */
export function orderBench(
  players: PlayerProjection[],
  score: (p: PlayerProjection) => number,
): PlayerProjection[] {
  const keeper = players.filter((p) => p.position === 'GKP');
  const outfield = players.filter((p) => p.position !== 'GKP').sort((a, b) => score(b) - score(a));
  return [...keeper, ...outfield];
}

/**
 * Total expected points from a squad across the horizon, playing the best legal
 * XI every week and captaining the best available player.
 *
 * This is the objective every transfer is judged against.
 */
export function squadValue(
  squad: PlayerProjection[],
  events: number[],
  index: EventPoints,
  weights: Weights,
  options: { includeCaptain?: boolean } = {},
): number {
  const includeCaptain = options.includeCaptain ?? true;
  const firstEvent = events.length > 0 ? events[0] : 0;

  let total = 0;
  for (const event of events) {
    const eleven = bestEleven(squad, event, index);
    let weekly = eleven.total;

    if (includeCaptain && eleven.starters.length > 0) {
      const best = Math.max(...eleven.starters.map((p) => pointsFor(index, p.playerId, event)));
      weekly += best;
    }

    total += weekly * Math.pow(weights.horizonDecay, event - firstEvent);
  }
  return total;
}

/** The gameweeks the engine plans over, starting at the upcoming one. */
export function horizonEvents(startEvent: number, weights: Weights): number[] {
  return Array.from({ length: weights.horizon }, (_, i) => startEvent + i);
}

/** Squad composition check: 2 keepers, 5 defenders, 5 midfielders, 3 forwards. */
export function hasLegalShape(squad: { position: PositionShort }[]): boolean {
  return POSITIONS.every(
    (pos) => squad.filter((p) => p.position === pos).length === SQUAD_SHAPE[pos],
  );
}

/** No more than three players from any one club. */
export function respectsClubLimit(squad: { teamId: number }[]): boolean {
  const counts = new Map<number, number>();
  for (const p of squad) counts.set(p.teamId, (counts.get(p.teamId) ?? 0) + 1);
  return [...counts.values()].every((n) => n <= 3);
}
