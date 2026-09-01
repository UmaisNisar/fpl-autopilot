import type { PositionShort } from '@/lib/fpl/types';
import type { SquadPlayer } from '@/lib/fpl/model';

export interface Lineup {
  startingXi: SquadPlayer[];
  bench: SquadPlayer[];
  formation: string;
}

/** Every legal outfield split: 3-5 DEF, 2-5 MID, 1-3 FWD, ten players total. */
export function legalFormations(): { def: number; mid: number; fwd: number }[] {
  const out: { def: number; mid: number; fwd: number }[] = [];
  for (let def = 3; def <= 5; def++) {
    for (let mid = 2; mid <= 5; mid++) {
      const fwd = 10 - def - mid;
      if (fwd >= 1 && fwd <= 3) out.push({ def, mid, fwd });
    }
  }
  return out;
}

export function formationLabel(xi: SquadPlayer[]): string {
  const count = (pos: PositionShort) => xi.filter((p) => p.position === pos).length;
  return `${count('DEF')}-${count('MID')}-${count('FWD')}`;
}

/**
 * The highest-projecting legal XI. Exhaustive over the ~14 legal formations,
 * which is cheap and removes any chance of an illegal lineup.
 */
export function bestStartingXi(
  squad: SquadPlayer[],
  score: (p: SquadPlayer) => number = (p) => p.projNext,
): Lineup {
  const byPos = (pos: PositionShort) =>
    squad.filter((p) => p.position === pos).sort((a, b) => score(b) - score(a));

  const keepers = byPos('GKP');
  const defenders = byPos('DEF');
  const midfielders = byPos('MID');
  const forwards = byPos('FWD');

  let best: { xi: SquadPlayer[]; total: number } | null = null;

  for (const shape of legalFormations()) {
    if (
      defenders.length < shape.def ||
      midfielders.length < shape.mid ||
      forwards.length < shape.fwd ||
      keepers.length < 1
    ) {
      continue;
    }

    const xi = [
      keepers[0],
      ...defenders.slice(0, shape.def),
      ...midfielders.slice(0, shape.mid),
      ...forwards.slice(0, shape.fwd),
    ];
    const total = xi.reduce((sum, p) => sum + score(p), 0);
    if (!best || total > best.total) best = { xi, total };
  }

  // Degenerate squad (shouldn't happen with 15 valid picks) - just take 11.
  const xi = best?.xi ?? squad.slice(0, 11);
  const xiIds = new Set(xi.map((p) => p.id));
  const remaining = squad.filter((p) => !xiIds.has(p.id));

  return {
    startingXi: sortForPitch(xi),
    bench: orderBench(remaining, score),
    formation: formationLabel(xi),
  };
}

/**
 * Bench order as FPL applies it: the reserve keeper sits outside the numbered
 * order, then the three outfield subs in the order they should come on.
 */
export function orderBench(
  players: SquadPlayer[],
  score: (p: SquadPlayer) => number = (p) => p.projNext,
): SquadPlayer[] {
  const keeper = players.filter((p) => p.position === 'GKP');
  const outfield = players
    .filter((p) => p.position !== 'GKP')
    .sort((a, b) => score(b) - score(a));
  return [...keeper, ...outfield];
}

const PITCH_ORDER: Record<PositionShort, number> = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };

/** Group by position so the pitch renders goalkeeper-first, top to bottom. */
export function sortForPitch(players: SquadPlayer[]): SquadPlayer[] {
  return [...players].sort(
    (a, b) => PITCH_ORDER[a.position] - PITCH_ORDER[b.position] || b.projNext - a.projNext,
  );
}

/** Check an XI satisfies FPL's formation rules. */
export function isLegalXi(xi: SquadPlayer[]): boolean {
  if (xi.length !== 11) return false;
  const count = (pos: PositionShort) => xi.filter((p) => p.position === pos).length;
  return (
    count('GKP') === 1 &&
    count('DEF') >= 3 &&
    count('DEF') <= 5 &&
    count('MID') >= 2 &&
    count('MID') <= 5 &&
    count('FWD') >= 1 &&
    count('FWD') <= 3
  );
}
