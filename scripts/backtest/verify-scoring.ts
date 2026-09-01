/**
 * Confirms the scoring rules the engine assumes against a full real season.
 * If FPL changes the rules, this is the test that catches it.
 */
import { readCsv, n } from './csv';
import { scorePerformance, type Performance } from '../../src/lib/engine/scoring';
import type { PositionShort } from '../../src/lib/fpl/types';

const SEASON = process.argv[2] ?? '2025-26';

let checked = 0;
let exact = 0;
const mismatches: Record<string, unknown>[] = [];

for (let gw = 1; gw <= 38; gw++) {
  let rows;
  try {
    rows = readCsv(`data/${SEASON}/gws/gw${gw}.csv`);
  } catch {
    continue;
  }

  for (const r of rows) {
    if (n(r.minutes) === 0) continue;
    const pos = (r.position === 'GK' ? 'GKP' : r.position) as PositionShort;

    const perf: Performance = {
      minutes: n(r.minutes),
      goals: n(r.goals_scored),
      assists: n(r.assists),
      cleanSheet: n(r.clean_sheets) > 0,
      goalsConceded: n(r.goals_conceded),
      saves: n(r.saves),
      penaltiesSaved: n(r.penalties_saved),
      penaltiesMissed: n(r.penalties_missed),
      yellowCards: n(r.yellow_cards),
      redCards: n(r.red_cards),
      ownGoals: n(r.own_goals),
      bonus: n(r.bonus),
      defensiveContribution: n(r.defensive_contribution),
    };

    const predicted = scorePerformance(pos, perf);
    const actual = n(r.total_points);
    checked++;
    if (predicted === actual) exact++;
    else if (mismatches.length < 10) {
      mismatches.push({ gw, name: r.name, pos, predicted, actual, ...perf });
    }
  }
}

const pct = ((100 * exact) / checked).toFixed(3);
console.log(`\n${SEASON}: ${exact}/${checked} appearances scored exactly (${pct}%)`);
if (mismatches.length) {
  console.log('\nFirst mismatches:');
  console.table(mismatches);
}
process.exit(exact === checked ? 0 : 1);
