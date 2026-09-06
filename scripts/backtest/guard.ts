/**
 * Regression guard for CI.
 *
 * The engine is tuned against held-out data, but nothing stops a later change
 * quietly undoing that. This re-runs the standard suite and fails if the engine
 * has slipped below two floors:
 *
 *  1. It must still beat the projection model it replaced.
 *  2. It must still score close to the season totals last recorded.
 *
 * The tolerance is deliberately loose. This is a tripwire for a real
 * regression, not a check that nothing ever moves -- a change that costs twenty
 * points across a season is noise, one that costs two hundred is a bug.
 *
 *   npx tsx scripts/backtest/guard.ts
 */
import { existsSync, readFileSync } from 'node:fs';

import { runAccuracy } from './accuracy';
import { runSuite, type TrackedRun } from './track';
import { ENGINE_VERSION } from '../../src/lib/engine/weights';

const HISTORY = 'backtest-results/history.json';
/** Points a season simulation may fall below its recorded figure. */
const SEASON_TOLERANCE = 60;

function recorded(): TrackedRun | null {
  if (!existsSync(HISTORY)) return null;
  try {
    const runs = JSON.parse(readFileSync(HISTORY, 'utf8')) as TrackedRun[];
    return runs.at(-1) ?? null;
  } catch {
    return null;
  }
}

const failures: string[] = [];

// --- 1. Still better than the model it replaced ----------------------------
const accuracy = runAccuracy('2025-26', { from: 6, to: 38 });
const v1 = accuracy.baselines.find((b) => b.label === 'engine v1');

console.log(`\nEngine ${ENGINE_VERSION} — regression guard\n`);
console.log(`  rank correlation   engine ${accuracy.engine.spearman}  vs v1 ${v1?.spearman ?? 'n/a'}`);
console.log(
  `  top-20 picks       engine ${accuracy.engine.top20MeanActual}  vs v1 ${v1?.top20MeanActual ?? 'n/a'}`,
);

if (v1 && accuracy.engine.spearman < v1.spearman) {
  failures.push(
    `rank correlation ${accuracy.engine.spearman} is below the model it replaced (${v1.spearman})`,
  );
}

// --- 2. Still scoring what it last recorded --------------------------------
const previous = recorded();
if (!previous) {
  console.log('\n  No recorded baseline yet — run `npm run backtest` to create one.');
} else {
  const current = runSuite();
  console.log(`\n  Season simulation, against ${previous.version}:`);

  for (const season of current.simulation) {
    const before = previous.simulation.find((s) => s.season === season.season);
    if (!before) continue;

    const now = season.totals.engine;
    const then = before.totals.engine;
    const delta = now - then;
    console.log(
      `    ${season.season}   ${then} -> ${now}   (${delta >= 0 ? '+' : ''}${delta})`,
    );

    if (delta < -SEASON_TOLERANCE) {
      failures.push(
        `${season.season} season simulation fell ${-delta} points, past the ${SEASON_TOLERANCE}-point tolerance`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('\nEngine regression:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('\nIf the change is deliberate, re-run `npm run backtest` to record a new baseline.\n');
  process.exit(1);
}

console.log('\n  No regression.\n');
