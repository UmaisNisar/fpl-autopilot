/**
 * Download historical FPL seasons for backtesting.
 *
 * Source: vaastav/Fantasy-Premier-League, which mirrors the official API into
 * per-gameweek CSVs. Data lands in data/<season>/ and is gitignored -- it is a
 * cache, not source.
 *
 *   node scripts/fetch-history.mjs 2025-26 2024-25
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = 'https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data';
const SEASONS = process.argv.slice(2).length ? process.argv.slice(2) : ['2025-26'];
const CONCURRENCY = 6;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  if (await exists(dest)) return 'cached';
  const res = await fetch(url);
  if (!res.ok) return `HTTP ${res.status}`;
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return 'ok';
}

async function pool(tasks, limit) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

for (const season of SEASONS) {
  const dir = join('data', season);
  await mkdir(join(dir, 'gws'), { recursive: true });

  const jobs = [
    ...['fixtures.csv', 'teams.csv', 'players_raw.csv'].map(
      (f) => () => download(`${BASE}/${season}/${f}`, join(dir, f)).then((r) => [f, r]),
    ),
    ...Array.from({ length: 38 }, (_, i) => i + 1).map(
      (gw) => () =>
        download(`${BASE}/${season}/gws/gw${gw}.csv`, join(dir, 'gws', `gw${gw}.csv`)).then((r) => [
          `gw${gw}`,
          r,
        ]),
    ),
  ];

  const results = await pool(jobs, CONCURRENCY);
  const failed = results.filter(([, r]) => r !== 'ok' && r !== 'cached');
  const fresh = results.filter(([, r]) => r === 'ok').length;

  console.log(
    `${season}: ${fresh} downloaded, ${results.length - fresh - failed.length} cached, ${failed.length} failed`,
  );
  if (failed.length) console.log('  failed:', failed.map(([f, r]) => `${f}(${r})`).join(', '));
}
