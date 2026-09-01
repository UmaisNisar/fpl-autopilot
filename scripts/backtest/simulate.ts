/**
 * Season simulation.
 *
 * Projection accuracy is a proxy. This is the thing itself: start from a squad,
 * walk the season a gameweek at a time, let a strategy make transfers, pick an
 * XI and a captain, then score it on what actually happened.
 *
 * Every strategy starts from the identical squad and sees only pre-deadline
 * information, so the difference between them is the decision-making.
 *
 *   npx tsx scripts/backtest/simulate.ts 2025-26
 */
import { assertNoLeakage, buildWorld, loadSeason, type SeasonData } from './season';
import { legacyProjections, legacyV1 } from './baselines';
import { runEngine } from '../../src/lib/engine/plan';
import { bestEleven, buildEventPoints } from '../../src/lib/engine/squad';
import { projectAll } from '../../src/lib/engine/plan';
import { TRANSFER_HIT_COST } from '../../src/lib/engine/scoring';
import { DEFAULT_WEIGHTS, ENGINE_VERSION, type Weights } from '../../src/lib/engine/weights';
import type { PlayerProjection, WorldState } from '../../src/lib/engine/types';
import type { PositionShort } from '../../src/lib/fpl/types';

const SHAPE: Record<PositionShort, number> = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
const MAX_FREE_TRANSFERS = 5;
const START_BUDGET = 100.0;

export interface SimResult {
  strategy: string;
  totalPoints: number;
  /** Points lost to transfer hits. */
  hitPoints: number;
  transfers: number;
  /** Points contributed by the captain's doubled score. */
  captainPoints: number;
  benchPoints: number;
  autoSubs: number;
  perGameweek: { event: number; points: number; hits: number }[];
}

interface SquadSlot {
  id: number;
  position: PositionShort;
  teamId: number;
  price: number;
}

/**
 * The starting squad, built from data available before the first simulated
 * gameweek. All strategies share it so nothing is decided by luck of the draw.
 */
function buildStartingSquad(world: WorldState, weights: Weights): SquadSlot[] {
  const { projections } = projectAll(world, weights);
  const counts: Record<PositionShort, number> = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  const clubs = new Map<number, number>();
  const squad: SquadSlot[] = [];
  let spent = 0;

  const pool = [...projections.values()]
    .filter((p) => p.horizon > 0 && p.price > 0)
    .sort((a, b) => b.horizon / b.price - a.horizon / a.price);

  for (const player of pool) {
    if (squad.length === 15) break;
    if (counts[player.position] >= SHAPE[player.position]) continue;
    if ((clubs.get(player.teamId) ?? 0) >= 3) continue;
    const slotsLeft = 15 - squad.length - 1;
    if (spent + player.price + slotsLeft * 4.0 > START_BUDGET) continue;

    squad.push({
      id: player.playerId,
      position: player.position,
      teamId: player.teamId,
      price: player.price,
    });
    counts[player.position] += 1;
    clubs.set(player.teamId, (clubs.get(player.teamId) ?? 0) + 1);
    spent += player.price;
  }

  return squad;
}

/** Minutes each player actually played that gameweek, for auto-substitutions. */
function minutesIn(season: SeasonData, event: number): Map<number, number> {
  const minutes = new Map<number, number>();
  for (const a of season.byRound.get(event) ?? []) {
    minutes.set(a.element, (minutes.get(a.element) ?? 0) + a.minutes);
  }
  return minutes;
}

function pointsIn(season: SeasonData, event: number): Map<number, number> {
  const points = new Map<number, number>();
  for (const a of season.byRound.get(event) ?? []) {
    points.set(a.element, (points.get(a.element) ?? 0) + a.points);
  }
  return points;
}

function positionsOf(ids: number[], squad: SquadSlot[]): PositionShort[] {
  return ids.map((id) => squad.find((s) => s.id === id)?.position ?? 'MID');
}

function isLegalXi(positions: PositionShort[]): boolean {
  const count = (p: PositionShort) => positions.filter((x) => x === p).length;
  return (
    positions.length === 11 &&
    count('GKP') === 1 &&
    count('DEF') >= 3 &&
    count('MID') >= 2 &&
    count('FWD') >= 1
  );
}

/**
 * FPL's automatic substitutions: a starter who did not play is replaced by the
 * first eligible bench player who did, provided the formation stays legal.
 */
function applyAutoSubs(
  startingXi: number[],
  bench: number[],
  squad: SquadSlot[],
  minutes: Map<number, number>,
): { xi: number[]; subs: number } {
  let xi = [...startingXi];
  const available = [...bench];
  let subs = 0;

  for (let i = 0; i < xi.length; i++) {
    if ((minutes.get(xi[i]) ?? 0) > 0) continue;

    for (let b = 0; b < available.length; b++) {
      const candidate = available[b];
      if ((minutes.get(candidate) ?? 0) <= 0) continue;

      const trial = [...xi];
      trial[i] = candidate;
      if (!isLegalXi(positionsOf(trial, squad))) continue;

      xi = trial;
      available.splice(b, 1);
      subs += 1;
      break;
    }
  }

  return { xi, subs };
}

export type Strategy = 'engine' | 'v1-projections' | 'engine-v1-xi' | 'hold-optimal-xi' | 'hold';

export interface SimOptions {
  season: SeasonData;
  from: number;
  to: number;
  weights?: Weights;
  strategy: Strategy;
  startingSquad: SquadSlot[];
}

export function simulate(options: SimOptions): SimResult {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const { season, from, to, strategy } = options;

  let squad = options.startingSquad.map((s) => ({ ...s }));
  let bank = round1(START_BUDGET - squad.reduce((sum, s) => sum + s.price, 0));
  let freeTransfers = 1;

  const result: SimResult = {
    strategy,
    totalPoints: 0,
    hitPoints: 0,
    transfers: 0,
    captainPoints: 0,
    benchPoints: 0,
    autoSubs: 0,
    perGameweek: [],
  };

  for (let event = from; event <= to; event++) {
    if (!season.byRound.has(event)) continue;

    const built = buildWorld(season, event, weights);
    assertNoLeakage(built, event);
    const world = built.world;

    // Refresh prices from what the player was worth going into this gameweek.
    const priceById = new Map(world.players.map((p) => [p.id, p.price]));
    squad = squad.map((s) => ({ ...s, price: priceById.get(s.id) ?? s.price }));

    let startingXi: number[] = [];
    let benchOrder: number[] = [];
    let captainId: number | null = null;
    let viceId: number | null = null;
    let hits = 0;

    if (strategy === 'engine' || strategy === 'v1-projections') {
      // Identical decision machinery; only the projections differ.
      const analysis = runEngine({
        world,
        squadIds: squad.map((s) => s.id),
        bank,
        freeTransfers,
        chipsAvailable: [],
        weights,
        rules: season.rules,
        projections:
          strategy === 'v1-projections' ? legacyProjections(world, weights) : undefined,
      });

      const rec = analysis.recommendation;
      for (const move of rec.moves) {
        const incoming = analysis.candidates.find((c) => c.playerId === move.inId);
        const outgoing = squad.find((s) => s.id === move.outId);
        if (!incoming || !outgoing) continue;
        bank = round1(bank + outgoing.price - incoming.price);
        squad = squad.map((s) =>
          s.id === move.outId
            ? {
                id: incoming.playerId,
                position: incoming.position,
                teamId: incoming.teamId,
                price: incoming.price,
              }
            : s,
        );
        result.transfers += 1;
      }

      const used = rec.moves.length;
      hits = Math.max(0, used - freeTransfers) * TRANSFER_HIT_COST;
      freeTransfers = Math.min(MAX_FREE_TRANSFERS, Math.max(0, freeTransfers - used) + 1);

      startingXi = rec.startingXi;
      benchOrder = rec.bench;
      captainId = rec.captainId;
      viceId = rec.viceCaptainId;
    } else {
      // Baselines never transfer; they differ only in how they pick the XI.
      freeTransfers = Math.min(MAX_FREE_TRANSFERS, freeTransfers + 1);

      const score =
        strategy === 'engine-v1-xi'
          ? (id: number) => {
              const state = world.players.find((p) => p.id === id);
              return state ? legacyV1(state, world, weights) : 0;
            }
          : strategy === 'hold-optimal-xi'
            ? (() => {
                const { projections } = projectAll(world, weights, season.rules);
                return (id: number) => projections.get(id)?.next ?? 0;
              })()
            : // 'hold' keeps whatever order the squad is in.
              (() => {
                const order = new Map(squad.map((s, i) => [s.id, squad.length - i]));
                return (id: number) => order.get(id) ?? 0;
              })();

      const picked = pickEleven(squad, score);
      startingXi = picked.xi;
      benchOrder = picked.bench;
      captainId = picked.captain;
      viceId = picked.vice;
    }

    // --- score the gameweek ------------------------------------------------
    const actual = pointsIn(season, event);
    const minutes = minutesIn(season, event);

    const { xi, subs } = applyAutoSubs(startingXi, benchOrder, squad, minutes);
    result.autoSubs += subs;

    let weekPoints = xi.reduce((sum, id) => sum + (actual.get(id) ?? 0), 0);

    // The captain doubles; if he did not play, the vice takes over.
    const captainPlayed = captainId !== null && (minutes.get(captainId) ?? 0) > 0;
    const effectiveCaptain = captainPlayed ? captainId : viceId;
    if (effectiveCaptain !== null && xi.includes(effectiveCaptain)) {
      const bonus = actual.get(effectiveCaptain) ?? 0;
      weekPoints += bonus;
      result.captainPoints += bonus;
    }

    const benchTotal = benchOrder
      .filter((id) => !xi.includes(id))
      .reduce((sum, id) => sum + (actual.get(id) ?? 0), 0);
    result.benchPoints += benchTotal;

    weekPoints -= hits;
    result.hitPoints += hits;
    result.totalPoints += weekPoints;
    result.perGameweek.push({ event, points: weekPoints, hits });
  }

  return result;
}

/** Best legal XI under an arbitrary scoring function, plus captain and vice. */
function pickEleven(squad: SquadSlot[], score: (id: number) => number) {
  const byPos = (pos: PositionShort) =>
    squad.filter((s) => s.position === pos).sort((a, b) => score(b.id) - score(a.id));

  const gk = byPos('GKP');
  const df = byPos('DEF');
  const md = byPos('MID');
  const fw = byPos('FWD');

  let best: { xi: SquadSlot[]; total: number } | null = null;
  for (let d = 3; d <= 5; d++) {
    for (let m = 2; m <= 5; m++) {
      const f = 10 - d - m;
      if (f < 1 || f > 3) continue;
      if (gk.length < 1 || df.length < d || md.length < m || fw.length < f) continue;
      const xi = [gk[0], ...df.slice(0, d), ...md.slice(0, m), ...fw.slice(0, f)];
      const total = xi.reduce((s, p) => s + score(p.id), 0);
      if (!best || total > best.total) best = { xi, total };
    }
  }

  const xi = best?.xi ?? squad.slice(0, 11);
  const xiIds = new Set(xi.map((p) => p.id));
  const benchPool = squad.filter((s) => !xiIds.has(s.id));
  const bench = [
    ...benchPool.filter((s) => s.position === 'GKP'),
    ...benchPool.filter((s) => s.position !== 'GKP').sort((a, b) => score(b.id) - score(a.id)),
  ];

  const ranked = [...xi].sort((a, b) => score(b.id) - score(a.id));
  return {
    xi: xi.map((p) => p.id),
    bench: bench.map((p) => p.id),
    captain: ranked[0]?.id ?? null,
    vice: ranked[1]?.id ?? null,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// --- CLI -------------------------------------------------------------------
if (process.argv[1]?.includes('simulate')) {
  const seasonName = process.argv[2] ?? '2025-26';
  const from = Number(process.argv[3] ?? 6);
  const to = Number(process.argv[4] ?? 38);

  const season = loadSeason(seasonName);
  const firstWorld = buildWorld(season, from, DEFAULT_WEIGHTS).world;
  const startingSquad = buildStartingSquad(firstWorld, DEFAULT_WEIGHTS);

  console.log(`\nSeason simulation — ${seasonName} GW${from}-${to}, engine ${ENGINE_VERSION}`);
  console.log(`All strategies start from the same 15 players, built from GW1-${from - 1} data.\n`);

  const strategies: Strategy[] = [
    'engine',
    'v1-projections',
    'engine-v1-xi',
    'hold-optimal-xi',
    'hold',
  ];
  const results: SimResult[] = [];

  for (const strategy of strategies) {
    const started = Date.now();
    const result = simulate({ season, from, to, strategy, startingSquad });
    results.push(result);
    console.log(
      `  ${strategy.padEnd(17)} ${String(result.totalPoints).padStart(5)} pts   ` +
        `(${result.transfers} transfers, -${result.hitPoints} hits, ${result.captainPoints} from captain, ` +
        `${result.benchPoints} left on bench)  [${((Date.now() - started) / 1000).toFixed(1)}s]`,
    );
  }

  const engine = results[0];
  console.log('\nAgainst each baseline');
  for (const other of results.slice(1)) {
    const delta = engine.totalPoints - other.totalPoints;
    console.log(
      `  vs ${other.strategy.padEnd(17)} ${delta >= 0 ? '+' : ''}${delta} pts over ${engine.perGameweek.length} gameweeks`,
    );
  }
  console.log();
}
