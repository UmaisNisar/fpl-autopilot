import { loadSeason, buildWorld } from './season';
import { DEFAULT_WEIGHTS } from '../../src/lib/engine/weights';

const started = Date.now();
const season = loadSeason('2025-26');
console.log(`  loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log('  previous-season map:', season.previous ? `${season.previous.size} players` : 'MISSING');

const world = buildWorld(season, 4, DEFAULT_WEIGHTS).world;
const withPrevious = world.players.filter((p) => p.previous && p.previous.minutes > 0);
console.log(`  players at GW4 carrying last season: ${withPrevious.length} of ${world.players.length}`);

for (const p of withPrevious.sort((a, b) => b.previous!.minutes - a.previous!.minutes).slice(0, 3)) {
  console.log(
    `    ${p.name.padEnd(16)} last season ${p.previous!.minutes} mins, ${p.previous!.starts} starts, ${p.previous!.points} pts`,
  );
}
