/**
 * A/B named weight variants on held-out data only.
 *
 * Coordinate descent optimises a single composite, which can hide a trade --
 * a variant that ranks slightly worse but is far better calibrated may still
 * be the one worth shipping now that projections are shown on screen and
 * compared against fixed chip thresholds. This prints the components so the
 * trade is visible rather than buried in one number.
 *
 *   npx tsx scripts/backtest/compare.ts
 */
import { actualPoints, assertNoLeakage, buildWorld, loadSeason } from './season';
import { spearman } from './accuracy';
import { projectAll } from '../../src/lib/engine/plan';
import { DEFAULT_WEIGHTS, type Weights } from '../../src/lib/engine/weights';

const MIN_MINUTES = 60;

interface Result {
  spearman: number;
  top20: number;
  bias: number;
  mae: number;
}

function measure(seasonName: string, from: number, to: number, weights: Weights): Result {
  const season = loadSeason(seasonName);
  let spearSum = 0;
  let top20Sum = 0;
  let weeks = 0;
  let predSum = 0;
  let actSum = 0;
  let absErr = 0;
  let n = 0;

  for (let event = from; event <= to; event++) {
    if (!season.byRound.has(event)) continue;
    const built = buildWorld(season, event, weights);
    assertNoLeakage(built, event);
    const { projections } = projectAll(built.world, weights, season.rules);
    const actual = actualPoints(season, event);

    const rows: { predicted: number; actual: number; event: number }[] = [];
    for (const p of built.world.players) {
      if (p.season.minutes < MIN_MINUTES) continue;
      const proj = projections.get(p.id);
      if (!proj) continue;
      rows.push({ predicted: proj.next, actual: actual.get(p.id) ?? 0, event });
    }
    if (rows.length === 0) continue;

    spearSum += spearman(rows);
    const top = [...rows].sort((a, b) => b.predicted - a.predicted).slice(0, 20);
    top20Sum += top.reduce((s, r) => s + r.actual, 0) / top.length;
    weeks += 1;
    for (const r of rows) {
      predSum += r.predicted;
      actSum += r.actual;
      absErr += Math.abs(r.predicted - r.actual);
      n += 1;
    }
  }

  return {
    spearman: spearSum / weeks,
    top20: top20Sum / weeks,
    bias: (predSum - actSum) / n,
    mae: absErr / n,
  };
}

const VARIANTS: { name: string; weights: Weights }[] = [
  {
    name: 'last season OFF',
    weights: { ...DEFAULT_WEIGHTS, previousSeasonWeight: 0, previousStartWeight: 0 },
  },
  {
    name: 'rates only',
    weights: { ...DEFAULT_WEIGHTS, previousSeasonWeight: 0.25, previousStartWeight: 0 },
  },
  {
    name: 'starts only',
    weights: { ...DEFAULT_WEIGHTS, previousSeasonWeight: 0, previousStartWeight: 0.35 },
  },
  {
    name: 'both',
    weights: { ...DEFAULT_WEIGHTS, previousSeasonWeight: 0.25, previousStartWeight: 0.35 },
  },
];

const SPLITS: { label: string; season: string; from: number; to: number }[] = [
  { label: 'full 2025-26 GW6-38', season: '2025-26', from: 6, to: 38 },
  { label: 'holdout 2025-26 GW20-38', season: '2025-26', from: 20, to: 38 },
  { label: 'out-of-sample 2024-25', season: '2024-25', from: 6, to: 38 },
  { label: 'early season 2025-26 GW3-8', season: '2025-26', from: 3, to: 8 },
];

for (const split of SPLITS) {
  console.log(`\n${split.label}`);
  console.log('  variant                       spearman   top20    bias     MAE');
  console.log('  ' + '-'.repeat(62));
  for (const variant of VARIANTS) {
    const r = measure(split.season, split.from, split.to, variant.weights);
    console.log(
      `  ${variant.name.padEnd(28)} ${r.spearman.toFixed(3)}    ${r.top20.toFixed(2)}   ` +
        `${(r.bias >= 0 ? '+' : '') + r.bias.toFixed(3)}   ${r.mae.toFixed(3)}`,
    );
  }
}
console.log();
