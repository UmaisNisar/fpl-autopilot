/**
 * Model performance tracking across engine versions.
 *
 * Runs the standard suite and appends the result to
 * `backtest-results/history.json`, so it is always possible to answer the only
 * question that matters after a change: did this actually make the
 * recommendations better, or did it just move numbers around?
 *
 *   npx tsx scripts/backtest/track.ts          record the current version
 *   npx tsx scripts/backtest/track.ts --show   print the history, no run
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runAccuracy } from './accuracy';
import { simulate, type Strategy } from './simulate';
import { buildWorld, loadSeason } from './season';
import { projectAll } from '../../src/lib/engine/plan';
import { DEFAULT_WEIGHTS, ENGINE_VERSION, type Weights } from '../../src/lib/engine/weights';
import type { PositionShort } from '../../src/lib/fpl/types';

const RESULTS_DIR = 'backtest-results';
const HISTORY = `${RESULTS_DIR}/history.json`;

/** The fixed suite. Changing this invalidates comparisons, so keep it stable. */
const SUITE = {
  accuracy: [
    { season: '2025-26', from: 6, to: 38 },
    { season: '2024-25', from: 6, to: 38 },
  ],
  simulation: [
    { season: '2025-26', from: 6, to: 38 },
    { season: '2024-25', from: 6, to: 38 },
  ],
};

const STRATEGIES: Strategy[] = ['engine', 'v1-projections', 'hold-optimal-xi'];

export interface TrackedRun {
  version: string;
  recordedAt: string;
  weights: Weights;
  accuracy: {
    season: string;
    mae: number;
    rmse: number;
    spearman: number;
    top20MeanActual: number;
    /** Same metrics for the engine this one replaced, from the same run. */
    v1Spearman: number;
    v1Mae: number;
  }[];
  simulation: {
    season: string;
    totals: Record<string, number>;
    transfers: number;
    hitPoints: number;
    /** Engine minus the best baseline. */
    edge: number;
  }[];
  /** One-line summary for the leaderboard. */
  headline: string;
}

const SHAPE: Record<PositionShort, number> = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };

function startingSquad(seasonName: string, from: number, weights: Weights) {
  const season = loadSeason(seasonName);
  const world = buildWorld(season, from, weights).world;
  const { projections } = projectAll(world, weights, season.rules);

  const counts: Record<PositionShort, number> = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  const clubs = new Map<number, number>();
  const squad: { id: number; position: PositionShort; teamId: number; price: number }[] = [];
  let spent = 0;

  for (const p of [...projections.values()]
    .filter((p) => p.horizon > 0 && p.price > 0)
    .sort((a, b) => b.horizon / b.price - a.horizon / a.price)) {
    if (squad.length === 15) break;
    if (counts[p.position] >= SHAPE[p.position]) continue;
    if ((clubs.get(p.teamId) ?? 0) >= 3) continue;
    if (spent + p.price + (15 - squad.length - 1) * 4.0 > 100) continue;
    squad.push({ id: p.playerId, position: p.position, teamId: p.teamId, price: p.price });
    counts[p.position] += 1;
    clubs.set(p.teamId, (clubs.get(p.teamId) ?? 0) + 1);
    spent += p.price;
  }

  return { season, squad };
}

export function runSuite(): TrackedRun {
  const accuracy: TrackedRun['accuracy'] = [];
  for (const spec of SUITE.accuracy) {
    const result = runAccuracy(spec.season, { from: spec.from, to: spec.to });
    const v1 = result.baselines.find((b) => b.label === 'engine v1');
    accuracy.push({
      season: spec.season,
      mae: result.engine.mae,
      rmse: result.engine.rmse,
      spearman: result.engine.spearman,
      top20MeanActual: result.engine.top20MeanActual,
      v1Spearman: v1?.spearman ?? 0,
      v1Mae: v1?.mae ?? 0,
    });
  }

  const simulation: TrackedRun['simulation'] = [];
  for (const spec of SUITE.simulation) {
    const { season, squad } = startingSquad(spec.season, spec.from, DEFAULT_WEIGHTS);
    const totals: Record<string, number> = {};
    let transfers = 0;
    let hitPoints = 0;

    for (const strategy of STRATEGIES) {
      const result = simulate({
        season,
        from: spec.from,
        to: spec.to,
        strategy,
        startingSquad: squad,
      });
      totals[strategy] = result.totalPoints;
      if (strategy === 'engine') {
        transfers = result.transfers;
        hitPoints = result.hitPoints;
      }
    }

    const bestBaseline = Math.max(
      ...STRATEGIES.filter((s) => s !== 'engine').map((s) => totals[s] ?? 0),
    );
    simulation.push({
      season: spec.season,
      totals,
      transfers,
      hitPoints,
      edge: totals.engine - bestBaseline,
    });
  }

  const meanSpearman = accuracy.reduce((s, a) => s + a.spearman, 0) / accuracy.length;
  const totalEdge = simulation.reduce((s, x) => s + x.edge, 0);

  return {
    version: ENGINE_VERSION,
    recordedAt: new Date().toISOString(),
    weights: DEFAULT_WEIGHTS,
    accuracy,
    simulation,
    headline: `spearman ${meanSpearman.toFixed(3)}, season edge +${totalEdge} pts`,
  };
}

function loadHistory(): TrackedRun[] {
  if (!existsSync(HISTORY)) return [];
  try {
    return JSON.parse(readFileSync(HISTORY, 'utf8')) as TrackedRun[];
  } catch {
    return [];
  }
}

function saveHistory(history: TrackedRun[]) {
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(HISTORY, JSON.stringify(history, null, 2));
}

export function printHistory(history: TrackedRun[]) {
  if (history.length === 0) {
    console.log('\nNo runs recorded yet.\n');
    return;
  }

  console.log('\nEngine performance history');
  console.log(
    'version   recorded            spearman   MAE     vs v1      2025-26 sim   2024-25 sim',
  );
  console.log('-'.repeat(94));

  for (const run of history) {
    const a25 = run.accuracy.find((a) => a.season === '2025-26');
    const meanSpearman = run.accuracy.reduce((s, a) => s + a.spearman, 0) / run.accuracy.length;
    const meanMae = run.accuracy.reduce((s, a) => s + a.mae, 0) / run.accuracy.length;
    const vsV1 = a25 ? a25.spearman - a25.v1Spearman : 0;
    const sim25 = run.simulation.find((s) => s.season === '2025-26');
    const sim24 = run.simulation.find((s) => s.season === '2024-25');

    console.log(
      [
        run.version.padEnd(9),
        run.recordedAt.slice(0, 16).replace('T', ' ').padEnd(19),
        meanSpearman.toFixed(3).padStart(8),
        meanMae.toFixed(3).padStart(7),
        `${vsV1 >= 0 ? '+' : ''}${vsV1.toFixed(3)}`.padStart(9),
        `${sim25?.totals.engine ?? '-'} (${sim25 ? (sim25.edge >= 0 ? '+' : '') + sim25.edge : '-'})`.padStart(14),
        `${sim24?.totals.engine ?? '-'} (${sim24 ? (sim24.edge >= 0 ? '+' : '') + sim24.edge : '-'})`.padStart(14),
      ].join(' '),
    );
  }

  if (history.length >= 2) {
    const latest = history[history.length - 1];
    const previous = history[history.length - 2];
    const dSpearman =
      latest.accuracy.reduce((s, a) => s + a.spearman, 0) / latest.accuracy.length -
      previous.accuracy.reduce((s, a) => s + a.spearman, 0) / previous.accuracy.length;
    const dEdge =
      latest.simulation.reduce((s, x) => s + x.edge, 0) -
      previous.simulation.reduce((s, x) => s + x.edge, 0);

    console.log(`\n${previous.version} -> ${latest.version}`);
    console.log(`  rank correlation  ${dSpearman >= 0 ? '+' : ''}${dSpearman.toFixed(4)}`);
    console.log(`  season edge       ${dEdge >= 0 ? '+' : ''}${dEdge} pts`);
    console.log(
      dSpearman >= 0 && dEdge >= 0
        ? '  the change improved both measures'
        : dSpearman >= 0 || dEdge >= 0
          ? '  mixed: one measure improved, one did not'
          : '  the change made things worse — consider reverting',
    );
  }
  console.log();
}

// --- CLI -------------------------------------------------------------------
if (process.argv[1]?.includes('track')) {
  const history = loadHistory();

  if (process.argv.includes('--show')) {
    printHistory(history);
  } else {
    console.log(`\nRunning the backtest suite for engine ${ENGINE_VERSION}…`);
    const run = runSuite();

    // One entry per version: re-running a version replaces its record.
    const filtered = history.filter((h) => h.version !== run.version);
    filtered.push(run);
    saveHistory(filtered);

    console.log(`Recorded: ${run.headline}`);
    printHistory(filtered);
  }
}
