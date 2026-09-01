/**
 * Calibration diagnostics.
 *
 * Accuracy tells you whether the engine is good. This tells you *how* it is
 * wrong, which is the part you can act on: whether it is biased overall, which
 * positions it misreads, which prediction bands it inflates, and which scoring
 * component is responsible.
 *
 *   npx tsx scripts/backtest/calibration.ts 2025-26
 */
import { actualPoints, assertNoLeakage, buildWorld, loadSeason } from './season';
import { projectAll } from '../../src/lib/engine/plan';
import { DEFAULT_WEIGHTS, ENGINE_VERSION, type Weights } from '../../src/lib/engine/weights';
import { scorePerformance, type Performance } from '../../src/lib/engine/scoring';
import type { PositionShort } from '../../src/lib/fpl/types';

const MIN_SEASON_MINUTES = 60;

interface Record_ {
  predicted: number;
  actual: number;
  position: PositionShort;
  playedMinutes: number;
  /** Predicted appearance-points contribution. */
  predAppearance: number;
  predGoals: number;
  predAssists: number;
  predCleanSheet: number;
  predDefcon: number;
  predBonus: number;
  predSaves: number;
}

export function collect(
  seasonName: string,
  from: number,
  to: number,
  weights: Weights = DEFAULT_WEIGHTS,
): Record_[] {
  const season = loadSeason(seasonName);
  const out: Record_[] = [];

  for (let event = from; event <= to; event++) {
    if (!season.byRound.has(event)) continue;

    const built = buildWorld(season, event, weights);
    assertNoLeakage(built, event);
    const world = built.world;

    const { projections } = projectAll(world, weights, season.rules);
    const actual = actualPoints(season, event);

    const minutesThisWeek = new Map<number, number>();
    for (const a of season.byRound.get(event) ?? []) {
      minutesThisWeek.set(a.element, (minutesThisWeek.get(a.element) ?? 0) + a.minutes);
    }

    for (const player of world.players) {
      if (player.season.minutes < MIN_SEASON_MINUTES) continue;
      const projection = projections.get(player.id);
      if (!projection) continue;

      const next = projection.fixtures.filter(
        (f) => f.event === Math.min(...projection.fixtures.map((x) => x.event)),
      );
      const sum = (pick: (c: (typeof next)[0]['components']) => number) =>
        next.reduce((s, f) => s + pick(f.components), 0);

      out.push({
        predicted: projection.next,
        actual: actual.get(player.id) ?? 0,
        position: player.position,
        playedMinutes: minutesThisWeek.get(player.id) ?? 0,
        predAppearance: sum((c) => c.appearance),
        predGoals: sum((c) => c.goals),
        predAssists: sum((c) => c.assists),
        predCleanSheet: sum((c) => c.cleanSheet),
        predDefcon: sum((c) => c.defcon),
        predBonus: sum((c) => c.bonus),
        predSaves: sum((c) => c.saves),
      });
    }
  }

  return out;
}

/** Actual points broken into the same components, for a like-for-like check. */
export function actualComponents(seasonName: string, from: number, to: number) {
  const season = loadSeason(seasonName);
  const totals = {
    appearance: 0,
    goals: 0,
    assists: 0,
    cleanSheet: 0,
    defcon: 0,
    bonus: 0,
    saves: 0,
    concede: 0,
    cards: 0,
    rows: 0,
  };

  for (let event = from; event <= to; event++) {
    for (const a of season.byRound.get(event) ?? []) {
      totals.rows += 1;
      if (a.minutes <= 0) continue;
      totals.appearance += a.minutes >= 60 ? 2 : 1;
      totals.goals += a.goals * (a.position === 'GKP' || a.position === 'DEF' ? 6 : a.position === 'MID' ? 5 : 4);
      totals.assists += a.assists * 3;
      if (a.minutes >= 60 && a.cleanSheets > 0) {
        totals.cleanSheet += a.position === 'GKP' || a.position === 'DEF' ? 4 : a.position === 'MID' ? 1 : 0;
      }
      if (a.position === 'GKP') totals.saves += Math.floor(a.saves / 3);
      if (a.position === 'GKP' || a.position === 'DEF') totals.concede -= Math.floor(a.goalsConceded / 2);
      const threshold = a.position === 'DEF' ? 10 : a.position === 'GKP' ? Infinity : 12;
      if (a.defcon >= threshold) totals.defcon += 2;
      totals.bonus += a.bonus;
      totals.cards -= a.yellow + a.red * 3;
    }
  }
  return totals;
}

function bias(records: Record_[]) {
  const meanPred = records.reduce((s, r) => s + r.predicted, 0) / records.length;
  const meanAct = records.reduce((s, r) => s + r.actual, 0) / records.length;
  return { meanPred, meanAct, bias: meanPred - meanAct, n: records.length };
}

function pad(v: number, width = 7, digits = 3) {
  return v.toFixed(digits).padStart(width);
}

// --- CLI -------------------------------------------------------------------
if (process.argv[1]?.includes('calibration')) {
  const seasonName = process.argv[2] ?? '2025-26';
  const from = Number(process.argv[3] ?? 6);
  const to = Number(process.argv[4] ?? 38);

  const records = collect(seasonName, from, to);
  const overall = bias(records);

  console.log(`\nCalibration — ${seasonName} GW${from}-${to}, engine ${ENGINE_VERSION}`);
  console.log(`${overall.n} player-gameweeks\n`);
  console.log(
    `overall   predicted ${overall.meanPred.toFixed(3)}   actual ${overall.meanAct.toFixed(3)}   bias ${overall.bias >= 0 ? '+' : ''}${overall.bias.toFixed(3)}`,
  );

  console.log('\nBy position');
  console.log('pos    n      predicted  actual    bias');
  console.log('-'.repeat(46));
  for (const pos of ['GKP', 'DEF', 'MID', 'FWD'] as PositionShort[]) {
    const subset = records.filter((r) => r.position === pos);
    if (subset.length === 0) continue;
    const b = bias(subset);
    console.log(
      `${pos.padEnd(6)} ${String(b.n).padStart(5)}  ${pad(b.meanPred)}  ${pad(b.meanAct)}  ${b.bias >= 0 ? '+' : ''}${b.bias.toFixed(3)}`,
    );
  }

  console.log('\nBy predicted band (is a 6-point projection really worth 6?)');
  console.log('band          n      predicted  actual    bias');
  console.log('-'.repeat(52));
  const bands = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
    [6, 8],
    [8, 100],
  ];
  for (const [lo, hi] of bands) {
    const subset = records.filter((r) => r.predicted >= lo && r.predicted < hi);
    if (subset.length < 20) continue;
    const b = bias(subset);
    console.log(
      `${`${lo}-${hi === 100 ? '+' : hi}`.padEnd(12)} ${String(b.n).padStart(5)}  ${pad(b.meanPred)}  ${pad(b.meanAct)}  ${b.bias >= 0 ? '+' : ''}${b.bias.toFixed(3)}`,
    );
  }

  console.log('\nDid they actually play? (the minutes model in isolation)');
  const played = records.filter((r) => r.playedMinutes > 0);
  const missed = records.filter((r) => r.playedMinutes === 0);
  console.log(
    `  featured     n=${String(played.length).padStart(5)}  predicted ${(played.reduce((s, r) => s + r.predicted, 0) / played.length).toFixed(3)}  actual ${(played.reduce((s, r) => s + r.actual, 0) / played.length).toFixed(3)}`,
  );
  console.log(
    `  did not      n=${String(missed.length).padStart(5)}  predicted ${(missed.reduce((s, r) => s + r.predicted, 0) / Math.max(1, missed.length)).toFixed(3)}  actual 0.000   <- pure over-prediction`,
  );
  console.log(
    `  share of all projected points spent on non-appearances: ${((100 * missed.reduce((s, r) => s + r.predicted, 0)) / records.reduce((s, r) => s + r.predicted, 0)).toFixed(1)}%`,
  );

  console.log('\nPredicted component mix vs what the league actually paid out');
  const totalPred = records.reduce((s, r) => s + r.predicted, 0);
  const comp = {
    appearance: records.reduce((s, r) => s + r.predAppearance, 0),
    goals: records.reduce((s, r) => s + r.predGoals, 0),
    assists: records.reduce((s, r) => s + r.predAssists, 0),
    cleanSheet: records.reduce((s, r) => s + r.predCleanSheet, 0),
    defcon: records.reduce((s, r) => s + r.predDefcon, 0),
    bonus: records.reduce((s, r) => s + r.predBonus, 0),
    saves: records.reduce((s, r) => s + r.predSaves, 0),
  };
  const act = actualComponents(seasonName, from, to);
  const actTotal = act.appearance + act.goals + act.assists + act.cleanSheet + act.defcon + act.bonus + act.saves;

  console.log('component      predicted%   actual%');
  console.log('-'.repeat(38));
  for (const key of ['appearance', 'goals', 'assists', 'cleanSheet', 'defcon', 'bonus', 'saves'] as const) {
    const p = (100 * comp[key]) / totalPred;
    const a = (100 * act[key]) / actTotal;
    console.log(`${key.padEnd(14)} ${p.toFixed(1).padStart(8)}%  ${a.toFixed(1).padStart(7)}%`);
  }
  console.log();
}
