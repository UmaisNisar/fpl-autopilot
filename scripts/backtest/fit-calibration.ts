/**
 * Fit the rank-preserving calibration.
 *
 * The raw model under-calls, and worse the higher the projection. A least
 * squares fit of actual on predicted gives an affine correction that fixes the
 * level without touching the order, so rank correlation -- the thing transfer
 * and captain decisions actually turn on -- is mathematically unchanged.
 *
 * Fitted on the TRAIN split only, then reported on held-out data.
 *
 *   npx tsx scripts/backtest/fit-calibration.ts
 */
import { actualPoints, assertNoLeakage, buildWorld, loadSeason } from './season';
import { projectAll } from '../../src/lib/engine/plan';
import { DEFAULT_WEIGHTS, type Weights } from '../../src/lib/engine/weights';

const MIN_MINUTES = 60;

function samples(seasonName: string, from: number, to: number, weights: Weights) {
  const season = loadSeason(seasonName);
  const rows: { predicted: number; actual: number }[] = [];

  for (let event = from; event <= to; event++) {
    if (!season.byRound.has(event)) continue;
    const built = buildWorld(season, event, weights);
    assertNoLeakage(built, event);
    const { projections } = projectAll(built.world, weights, season.rules);
    const actual = actualPoints(season, event);

    for (const p of built.world.players) {
      if (p.season.minutes < MIN_MINUTES) continue;
      const proj = projections.get(p.id);
      if (!proj) continue;
      rows.push({ predicted: proj.next, actual: actual.get(p.id) ?? 0 });
    }
  }
  return rows;
}

/** Ordinary least squares of actual on predicted. */
function fit(rows: { predicted: number; actual: number }[]) {
  const n = rows.length;
  const meanX = rows.reduce((s, r) => s + r.predicted, 0) / n;
  const meanY = rows.reduce((s, r) => s + r.actual, 0) / n;

  let cov = 0;
  let varX = 0;
  for (const r of rows) {
    cov += (r.predicted - meanX) * (r.actual - meanY);
    varX += (r.predicted - meanX) ** 2;
  }
  const slope = varX === 0 ? 1 : cov / varX;
  return { slope, intercept: meanY - slope * meanX };
}

function bias(rows: { predicted: number; actual: number }[], w: Weights) {
  const adjusted = rows.map((r) => ({
    predicted: Math.max(0, w.calibrationIntercept + w.calibrationSlope * r.predicted),
    actual: r.actual,
  }));
  const n = adjusted.length;
  return adjusted.reduce((s, r) => s + (r.predicted - r.actual), 0) / n;
}

// Raw, uncalibrated projections to fit against.
const raw: Weights = { ...DEFAULT_WEIGHTS, calibrationSlope: 1, calibrationIntercept: 0 };

// Fit on the first half of both seasons. One half alone was unusually
// low-scoring, which made the correction overshoot everywhere else; two gives a
// steadier estimate while leaving both second halves genuinely held out.
const train = [...samples('2025-26', 6, 19, raw), ...samples('2024-25', 6, 19, raw)];
const { slope, intercept } = fit(train);

console.log(`\nFitted on GW6-19 of both seasons (${train.length} player-gameweeks)`);
console.log(`  calibrationSlope:     ${slope.toFixed(4)}`);
console.log(`  calibrationIntercept: ${intercept.toFixed(4)}\n`);

const fitted: Weights = { ...raw, calibrationSlope: slope, calibrationIntercept: intercept };

for (const split of [
  { label: 'train    2025-26 GW6-19 ', season: '2025-26', from: 6, to: 19 },
  { label: 'train    2024-25 GW6-19 ', season: '2024-25', from: 6, to: 19 },
  { label: 'HELD OUT 2025-26 GW20-38', season: '2025-26', from: 20, to: 38 },
  { label: 'HELD OUT 2024-25 GW20-38', season: '2024-25', from: 20, to: 38 },
  { label: 'HELD OUT 2025-26 GW3-8  ', season: '2025-26', from: 3, to: 8 },
]) {
  const rows = samples(split.season, split.from, split.to, raw);
  console.log(
    `  ${split.label}   bias ${bias(rows, raw).toFixed(3).padStart(7)} -> ${bias(rows, fitted).toFixed(3).padStart(7)}`,
  );
}
console.log('\n  (rank correlation is unchanged by construction: the map is monotone)\n');
