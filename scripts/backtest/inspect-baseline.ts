/**
 * Integrity check on FPL's published expected-points column.
 *
 * If `xP` were a genuine pre-deadline forecast it could not know whether a
 * player was about to feature. If it separates players who played from players
 * who did not, it was snapshotted after the fact and cannot be used as a
 * baseline.
 */
import { loadSeason } from './season';

for (const seasonName of ['2025-26', '2024-25']) {
  const season = loadSeason(seasonName);
  let playedSum = 0;
  let playedCount = 0;
  let benchedSum = 0;
  let benchedCount = 0;
  let zeroWhenBenched = 0;

  for (const gw of season.rounds) {
    const rows = season.byRound.get(gw) ?? [];
    if (rows.filter((r) => r.fplXp > 0).length < 20) continue;
    for (const r of rows) {
      if (r.minutes > 0) {
        playedSum += r.fplXp;
        playedCount++;
      } else {
        benchedSum += r.fplXp;
        benchedCount++;
        if (r.fplXp === 0) zeroWhenBenched++;
      }
    }
  }

  console.log(`\n${seasonName}`);
  console.log(`  mean xP when the player featured : ${(playedSum / Math.max(1, playedCount)).toFixed(3)}  (n=${playedCount})`);
  console.log(`  mean xP when the player did NOT  : ${(benchedSum / Math.max(1, benchedCount)).toFixed(3)}  (n=${benchedCount})`);
  console.log(`  share of non-appearances with xP exactly 0: ${((100 * zeroWhenBenched) / Math.max(1, benchedCount)).toFixed(1)}%`);
}
