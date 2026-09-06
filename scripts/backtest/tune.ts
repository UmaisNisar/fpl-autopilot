/**
 * Walk-forward weight tuning.
 *
 * Rules of engagement, so this improves the engine rather than overfitting it:
 *
 *  1. Weights are only ever fitted on the TRAIN split.
 *  2. The TEST split and a whole separate season are scored but never optimised
 *     against, and are the only numbers used to accept or reject a change.
 *  3. Coordinate descent over a small grid, not a free-for-all search. Fewer
 *     knobs turned means less chance of fitting noise.
 *  4. A change is only worth taking if it holds up on both held-out sets.
 *
 *   npx tsx scripts/backtest/tune.ts
 */
import { actualPoints, assertNoLeakage, buildWorld, loadSeason, type SeasonData } from './season';
import { spearman } from './accuracy';
import { projectAll } from '../../src/lib/engine/plan';
import type { SeasonRules } from '../../src/lib/engine/expected';
import { DEFAULT_WEIGHTS, ENGINE_VERSION, type Weights } from '../../src/lib/engine/weights';
import type { WorldState } from '../../src/lib/engine/types';

const MIN_SEASON_MINUTES = 60;

interface Split {
  season: SeasonData;
  rules: SeasonRules;
  worlds: { event: number; world: WorldState; actual: Map<number, number> }[];
}

/**
 * Build every world in a range once. Constructing them is the slow part;
 * projecting with different weights afterwards is cheap, which is what makes a
 * grid search affordable.
 */
function prepare(season: SeasonData, from: number, to: number, recentWindow: number): Split {
  const weights = { ...DEFAULT_WEIGHTS, recentWindow };
  const worlds: Split['worlds'] = [];

  for (let event = from; event <= to; event++) {
    if (!season.byRound.has(event)) continue;
    const built = buildWorld(season, event, weights);
    assertNoLeakage(built, event);
    worlds.push({ event, world: built.world, actual: actualPoints(season, event) });
  }

  return { season, rules: season.rules, worlds };
}

export interface Score {
  /** Mean actual points of the 20 players the model likes most each week. */
  top20: number;
  spearman: number;
  mae: number;
  /** Mean predicted minus mean actual. Negative means under-calling. */
  bias: number;
  /** Composite the search maximises. */
  objective: number;
}

/**
 * What the search maximises.
 *
 * Weighted toward the top of the ranking, because a manager only ever fields
 * fifteen players -- being well calibrated on players nobody owns is worth far
 * less than being right about who to pick.
 *
 * The earlier version of this subtracted MAE, which turned out to be a trap.
 * Most players score near zero, so on that distribution MAE quietly rewards
 * under-prediction: the search bought +0.02 of rank correlation and paid with
 * 2.4x the calibration error. Bias is penalised explicitly instead, which
 * matters now that these projections are shown on screen and compared against
 * fixed chip thresholds.
 */
function objectiveOf(top20: number, spearmanValue: number, bias: number): number {
  return top20 + 4 * spearmanValue - 3 * Math.abs(bias);
}

export function evaluate(split: Split, weights: Weights): Score {
  let top20Sum = 0;
  let spearmanSum = 0;
  let absError = 0;
  let predictedSum = 0;
  let actualSum = 0;
  let samples = 0;
  let weeks = 0;

  for (const { world, actual } of split.worlds) {
    const { projections } = projectAll(world, weights, split.rules);
    const rows: { predicted: number; actual: number; event: number }[] = [];

    for (const player of world.players) {
      if (player.season.minutes < MIN_SEASON_MINUTES) continue;
      const projection = projections.get(player.id);
      if (!projection) continue;
      rows.push({ predicted: projection.next, actual: actual.get(player.id) ?? 0, event: world.event });
    }
    if (rows.length === 0) continue;

    const ranked = [...rows].sort((a, b) => b.predicted - a.predicted).slice(0, 20);
    top20Sum += ranked.reduce((s, r) => s + r.actual, 0) / ranked.length;
    spearmanSum += spearman(rows);
    absError += rows.reduce((s, r) => s + Math.abs(r.predicted - r.actual), 0);
    predictedSum += rows.reduce((s, r) => s + r.predicted, 0);
    actualSum += rows.reduce((s, r) => s + r.actual, 0);
    samples += rows.length;
    weeks += 1;
  }

  const top20 = top20Sum / Math.max(1, weeks);
  const rank = spearmanSum / Math.max(1, weeks);
  const mae = absError / Math.max(1, samples);
  const bias = (predictedSum - actualSum) / Math.max(1, samples);

  return {
    top20: r3(top20),
    spearman: r3(rank),
    mae: r3(mae),
    bias: r3(bias),
    objective: r3(objectiveOf(top20, rank, bias)),
  };
}

/** The knobs the search is allowed to turn, and the values it may try. */
const GRID: { key: keyof Weights; values: number[] }[] = [
  { key: 'minutesRecencyWeight', values: [0.5, 0.6, 0.7, 0.8, 0.9] },
  { key: 'startPrior', values: [0.05, 0.15, 0.25, 0.35] },
  { key: 'startPriorStrength', values: [0.5, 1.0, 1.5, 2.5] },
  { key: 'recencyWeight', values: [0.3, 0.45, 0.6, 0.75] },
  { key: 'rateShrinkAppearances', values: [3, 5, 8, 12] },
  { key: 'strengthShrinkGames', values: [3, 6, 10, 16] },
  { key: 'bonusScale', values: [0.7, 0.85, 1.0, 1.15] },
  { key: 'starterSurvivesToHour', values: [0.78, 0.84, 0.88, 0.94] },
  // Zero is included deliberately: if last season does not earn its place, the
  // search is free to switch it off rather than have it forced on.
  { key: 'previousSeasonWeight', values: [0, 0.15, 0.25, 0.4, 0.6] },
  { key: 'previousStartWeight', values: [0, 0.15, 0.35, 0.6] },
];

export function coordinateDescent(
  train: Split,
  start: Weights,
  passes = 2,
): { weights: Weights; score: Score; trail: string[] } {
  let best = { ...start };
  let bestScore = evaluate(train, best);
  const trail: string[] = [`start objective ${bestScore.objective}`];

  for (let pass = 0; pass < passes; pass++) {
    let improvedThisPass = false;

    for (const { key, values } of GRID) {
      let localBest = best[key] as number;
      let localScore = bestScore;

      for (const value of values) {
        if (value === best[key]) continue;
        const candidate = { ...best, [key]: value };
        const score = evaluate(train, candidate);
        if (score.objective > localScore.objective + 1e-6) {
          localBest = value;
          localScore = score;
        }
      }

      if (localBest !== best[key]) {
        trail.push(
          `pass ${pass + 1}: ${key} ${String(best[key])} -> ${localBest}  objective ${bestScore.objective} -> ${localScore.objective}`,
        );
        best = { ...best, [key]: localBest };
        bestScore = localScore;
        improvedThisPass = true;
      }
    }

    if (!improvedThisPass) break;
  }

  return { weights: best, score: bestScore, trail };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function line(label: string, s: Score): string {
  return (
    `${label.padEnd(22)} top20 ${s.top20.toFixed(2).padStart(5)}   ` +
    `spearman ${s.spearman.toFixed(3)}   MAE ${s.mae.toFixed(3)}   ` +
    `bias ${(s.bias >= 0 ? '+' : '') + s.bias.toFixed(3)}   obj ${s.objective.toFixed(3)}`
  );
}

// --- CLI -------------------------------------------------------------------
if (process.argv[1]?.includes('tune')) {
  const trainSeason = loadSeason('2025-26');
  const testSeason = loadSeason('2024-25');

  // Fit on the first half of 2025-26 only.
  const train = prepare(trainSeason, 6, 19, DEFAULT_WEIGHTS.recentWindow);
  // Held out: the second half of the same season, and a different season.
  const holdout = prepare(trainSeason, 20, 38, DEFAULT_WEIGHTS.recentWindow);
  const otherSeason = prepare(testSeason, 6, 38, DEFAULT_WEIGHTS.recentWindow);

  console.log(`\nWeight tuning — engine ${ENGINE_VERSION}`);
  console.log('train    2025-26 GW6-19');
  console.log('holdout  2025-26 GW20-38   (never optimised against)');
  console.log('oos      2024-25 GW6-38    (different season, different rules)\n');

  const before = {
    train: evaluate(train, DEFAULT_WEIGHTS),
    holdout: evaluate(holdout, DEFAULT_WEIGHTS),
    oos: evaluate(otherSeason, DEFAULT_WEIGHTS),
  };

  console.log('Current weights');
  console.log('  ' + line('train', before.train));
  console.log('  ' + line('holdout', before.holdout));
  console.log('  ' + line('out of sample', before.oos));

  const result = coordinateDescent(train, DEFAULT_WEIGHTS);

  console.log('\nSearch trail');
  for (const step of result.trail) console.log('  ' + step);

  const after = {
    train: result.score,
    holdout: evaluate(holdout, result.weights),
    oos: evaluate(otherSeason, result.weights),
  };

  console.log('\nTuned weights');
  console.log('  ' + line('train', after.train));
  console.log('  ' + line('holdout', after.holdout));
  console.log('  ' + line('out of sample', after.oos));

  const changed = (Object.keys(result.weights) as (keyof Weights)[]).filter(
    (k) => result.weights[k] !== DEFAULT_WEIGHTS[k],
  );

  console.log('\nChanged values');
  if (changed.length === 0) console.log('  none — the current weights already win the search');
  for (const key of changed) {
    console.log(`  ${String(key).padEnd(24)} ${String(DEFAULT_WEIGHTS[key])} -> ${String(result.weights[key])}`);
  }

  const holdoutGain = after.holdout.objective - before.holdout.objective;
  const oosGain = after.oos.objective - before.oos.objective;

  console.log('\nVerdict (held-out data only)');
  console.log(`  holdout objective  ${holdoutGain >= 0 ? '+' : ''}${holdoutGain.toFixed(3)}`);
  console.log(`  out-of-sample      ${oosGain >= 0 ? '+' : ''}${oosGain.toFixed(3)}`);
  console.log(
    holdoutGain > 0 && oosGain > 0
      ? '  ACCEPT — improves on both held-out sets\n'
      : '  REJECT — does not hold up out of sample; likely fitted to noise\n',
  );

  if (holdoutGain > 0 && oosGain > 0) {
    console.log('Paste into DEFAULT_WEIGHTS:');
    for (const key of changed) console.log(`  ${String(key)}: ${String(result.weights[key])},`);
    console.log();
  }
}
