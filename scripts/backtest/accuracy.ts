/**
 * Walk-forward projection accuracy.
 *
 * For every gameweek, rebuild the world as it looked before the deadline,
 * project every player, then score those projections against what actually
 * happened. Nothing from the target gameweek is ever read -- `assertNoLeakage`
 * checks that on every iteration.
 *
 *   npx tsx scripts/backtest/accuracy.ts 2025-26
 */
import { actualPoints, assertNoLeakage, buildWorld, loadSeason } from './season';
import { BASELINES } from './baselines';
import { projectAll } from '../../src/lib/engine/plan';
import { DEFAULT_WEIGHTS, ENGINE_VERSION, type Weights } from '../../src/lib/engine/weights';

export interface AccuracyMetrics {
  label: string;
  samples: number;
  /** Mean absolute error against actual points. */
  mae: number;
  rmse: number;
  /** Rank correlation between projection and outcome, averaged per gameweek. */
  spearman: number;
  /** Mean actual points of the 20 highest-projected players each week. */
  top20MeanActual: number;
  /** Mean actual points of the highest-projected player each week. */
  top1MeanActual: number;
}

export interface AccuracyResult {
  season: string;
  version: string;
  from: number;
  to: number;
  gameweeks: number;
  engine: AccuracyMetrics;
  baselines: AccuracyMetrics[];
}

interface Sample {
  predicted: number;
  actual: number;
  event: number;
}

/** Only players with a real chance of being picked; deep squad filler is noise. */
const MIN_SEASON_MINUTES = 60;

export function runAccuracy(
  seasonName: string,
  options: { from?: number; to?: number; weights?: Weights } = {},
): AccuracyResult {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const season = loadSeason(seasonName);
  // Start late enough that there is history to learn from.
  const from = options.from ?? 6;
  const to = options.to ?? Math.max(...season.rounds);

  const engineSamples: Sample[] = [];
  const baselineSamples = BASELINES.map(() => [] as Sample[]);
  const weekMeanSamples: Sample[] = [];
  let gameweeks = 0;

  for (let event = from; event <= to; event++) {
    if (!season.byRound.has(event)) continue;

    const built = buildWorld(season, event, weights);
    assertNoLeakage(built, event);
    const world = built.world;

    const { projections } = projectAll(world, weights, season.rules);
    const actual = actualPoints(season, event);

    const eligible = world.players.filter((p) => p.season.minutes >= MIN_SEASON_MINUTES);
    if (eligible.length === 0) continue;
    gameweeks += 1;

    const weekMean =
      eligible.reduce((s, p) => s + (actual.get(p.id) ?? 0), 0) / eligible.length;

    for (const player of eligible) {
      const outcome = actual.get(player.id) ?? 0;
      const projection = projections.get(player.id);
      if (!projection) continue;

      engineSamples.push({ predicted: projection.next, actual: outcome, event });
      weekMeanSamples.push({ predicted: weekMean, actual: outcome, event });

      BASELINES.forEach((baseline, i) => {
        baselineSamples[i].push({
          predicted: baseline.fn(player, world, weights),
          actual: outcome,
          event,
        });
      });
    }
  }

  return {
    season: seasonName,
    version: ENGINE_VERSION,
    from,
    to,
    gameweeks,
    engine: summarise('engine', engineSamples),
    baselines: [
      ...BASELINES.map((b, i) => summarise(b.name, baselineSamples[i])),
      summarise('week mean', weekMeanSamples),
    ],
  };
}

export function summarise(label: string, samples: Sample[]): AccuracyMetrics {
  if (samples.length === 0) {
    return { label, samples: 0, mae: 0, rmse: 0, spearman: 0, top20MeanActual: 0, top1MeanActual: 0 };
  }

  const mae = samples.reduce((s, x) => s + Math.abs(x.predicted - x.actual), 0) / samples.length;
  const rmse = Math.sqrt(
    samples.reduce((s, x) => s + (x.predicted - x.actual) ** 2, 0) / samples.length,
  );

  // Rank correlation per gameweek, then averaged, so a big week does not dominate.
  const byEvent = new Map<number, Sample[]>();
  for (const s of samples) {
    const list = byEvent.get(s.event);
    if (list) list.push(s);
    else byEvent.set(s.event, [s]);
  }

  let spearmanSum = 0;
  let top20Sum = 0;
  let top1Sum = 0;
  let weeks = 0;

  for (const week of byEvent.values()) {
    spearmanSum += spearman(week);
    const ranked = [...week].sort((a, b) => b.predicted - a.predicted);
    const top20 = ranked.slice(0, 20);
    top20Sum += top20.reduce((s, x) => s + x.actual, 0) / Math.max(1, top20.length);
    top1Sum += ranked[0]?.actual ?? 0;
    weeks += 1;
  }

  return {
    label,
    samples: samples.length,
    mae: round3(mae),
    rmse: round3(rmse),
    spearman: round3(spearmanSum / Math.max(1, weeks)),
    top20MeanActual: round3(top20Sum / Math.max(1, weeks)),
    top1MeanActual: round3(top1Sum / Math.max(1, weeks)),
  };
}

/** Spearman rank correlation, averaging ranks across ties. */
export function spearman(samples: Sample[]): number {
  const n = samples.length;
  if (n < 2) return 0;

  const rank = (values: number[]): number[] => {
    const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array<number>(values.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1].v === order[i].v) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[order[k].i] = avg;
      i = j + 1;
    }
    return ranks;
  };

  const pr = rank(samples.map((s) => s.predicted));
  const ar = rank(samples.map((s) => s.actual));

  const meanP = pr.reduce((s, v) => s + v, 0) / n;
  const meanA = ar.reduce((s, v) => s + v, 0) / n;

  let cov = 0;
  let varP = 0;
  let varA = 0;
  for (let i = 0; i < n; i++) {
    const dp = pr[i] - meanP;
    const da = ar[i] - meanA;
    cov += dp * da;
    varP += dp * dp;
    varA += da * da;
  }
  const denom = Math.sqrt(varP * varA);
  return denom === 0 ? 0 : cov / denom;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function formatMetrics(rows: AccuracyMetrics[]): string {
  const lines = ['model             MAE    RMSE  spearman  top20avg  top1avg', '-'.repeat(62)];
  for (const m of rows) {
    lines.push(
      [
        m.label.padEnd(12),
        m.mae.toFixed(3).padStart(7),
        m.rmse.toFixed(3).padStart(7),
        m.spearman.toFixed(3).padStart(9),
        m.top20MeanActual.toFixed(2).padStart(9),
        m.top1MeanActual.toFixed(2).padStart(8),
      ].join(' '),
    );
  }
  return lines.join('\n');
}

// --- CLI -------------------------------------------------------------------
if (process.argv[1]?.includes('accuracy')) {
  const seasonName = process.argv[2] ?? '2025-26';
  const from = process.argv[3] ? Number(process.argv[3]) : undefined;
  const to = process.argv[4] ? Number(process.argv[4]) : undefined;

  const result = runAccuracy(seasonName, { from, to });

  console.log(`\nProjection accuracy — ${seasonName}, engine ${result.version}`);
  console.log(
    `GW${result.from}-${result.to} (${result.gameweeks} gameweeks, ${result.engine.samples} player-gameweeks)\n`,
  );
  console.log(formatMetrics([result.engine, ...result.baselines]));

  const v1 = result.baselines.find((b) => b.label === 'engine v1');
  if (v1) {
    const maeDelta = v1.mae - result.engine.mae;
    const rankDelta = result.engine.spearman - v1.spearman;
    const pickDelta = result.engine.top20MeanActual - v1.top20MeanActual;
    console.log(`\nAgainst the engine it replaces:`);
    console.log(`  MAE            ${maeDelta >= 0 ? 'better' : 'worse'} by ${Math.abs(maeDelta).toFixed(3)}`);
    console.log(`  rank corr.     ${rankDelta >= 0 ? 'better' : 'worse'} by ${Math.abs(rankDelta).toFixed(3)}`);
    console.log(`  top-20 picks   ${pickDelta >= 0 ? 'better' : 'worse'} by ${Math.abs(pickDelta).toFixed(2)} pts/player`);
  }
  console.log();
}
