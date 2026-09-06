/**
 * Did the weight tuning trade calibration away for ranking?
 *
 * The search maximised top-20 actual points, rank correlation and (negated)
 * MAE. On a distribution where most players score near zero, MAE quietly
 * rewards under-prediction -- so it is worth checking whether the tuned
 * weights systematically under-call every projection.
 */
import { actualPoints, assertNoLeakage, buildWorld, loadSeason } from './season';
import { spearman } from './accuracy';
import { projectAll } from '../../src/lib/engine/plan';
import { DEFAULT_WEIGHTS, type Weights } from '../../src/lib/engine/weights';

const UNTUNED: Weights = {
  ...DEFAULT_WEIGHTS,
  strengthShrinkGames: 6,
  minutesRecencyWeight: 0.8,
  startPrior: 0.3,
  startPriorStrength: 1.5,
  rateShrinkAppearances: 5,
  bonusScale: 1.0,
};

const MIN_MINUTES = 60;

function measure(seasonName: string, weights: Weights, label: string) {
  const season = loadSeason(seasonName);
  let predSum = 0;
  let actSum = 0;
  let n = 0;
  let spearSum = 0;
  let top20Sum = 0;
  let weeks = 0;

  for (let event = 6; event <= 38; event++) {
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

    for (const r of rows) {
      predSum += r.predicted;
      actSum += r.actual;
      n += 1;
    }
    spearSum += spearman(rows);
    const top = [...rows].sort((a, b) => b.predicted - a.predicted).slice(0, 20);
    top20Sum += top.reduce((s, r) => s + r.actual, 0) / top.length;
    weeks += 1;
  }

  const meanPred = predSum / n;
  const meanAct = actSum / n;
  console.log(
    `  ${label.padEnd(10)} predicted ${meanPred.toFixed(3)}  actual ${meanAct.toFixed(3)}  ` +
      `bias ${(meanPred - meanAct >= 0 ? '+' : '') + (meanPred - meanAct).toFixed(3)}  ` +
      `spearman ${(spearSum / weeks).toFixed(3)}  top20 ${(top20Sum / weeks).toFixed(2)}`,
  );
  return { bias: meanPred - meanAct, spearman: spearSum / weeks, top20: top20Sum / weeks };
}

for (const season of ['2025-26', '2024-25']) {
  console.log(`\n${season}`);
  const before = measure(season, UNTUNED, 'untuned');
  const after = measure(season, DEFAULT_WEIGHTS, 'tuned');
  console.log(
    `  -> ranking ${after.spearman > before.spearman ? 'improved' : 'worsened'} by ${Math.abs(after.spearman - before.spearman).toFixed(3)}, ` +
      `calibration ${Math.abs(after.bias) < Math.abs(before.bias) ? 'improved' : 'worsened'} (|bias| ${Math.abs(before.bias).toFixed(3)} -> ${Math.abs(after.bias).toFixed(3)})`,
  );
}
console.log();
