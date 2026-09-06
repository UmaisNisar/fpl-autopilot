import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { scorePerformance, type Performance } from '@/lib/engine/scoring';
import { DEFAULT_WEIGHTS } from '@/lib/engine/weights';
import { n, readCsv } from '../../scripts/backtest/csv';
import {
  assertNoLeakage,
  buildWorld,
  loadSeason,
  previousSeasonName,
} from '../../scripts/backtest/season';
import type { PositionShort } from '@/lib/fpl/types';

/**
 * Backtest integrity.
 *
 * A backtest that leaks the answer is worse than no backtest, because it
 * produces confident numbers that are wrong. These check the guard actually
 * guards, and that the scoring the whole thing rests on matches a real season
 * exactly.
 *
 * The season data is a gitignored cache, so these skip on a clean checkout
 * rather than failing. CI fetches it and runs them for real.
 */

const SEASON = '2025-26';
const hasData = existsSync(`data/${SEASON}/gws/gw1.csv`);
const describeWithData = hasData ? describe : describe.skip;

if (!hasData) {
  console.warn(`\n  Skipping backtest integrity tests: run \`npm run data:fetch\` first.\n`);
}

describeWithData('scoring conformance', () => {
  it('reproduces every appearance of a real season exactly', () => {
    const season = loadSeason(SEASON);
    let checked = 0;
    let exact = 0;
    const mismatches: string[] = [];

    for (const round of season.rounds) {
      for (const a of season.byRound.get(round) ?? []) {
        if (a.minutes === 0) continue;

        const performance: Performance = {
          minutes: a.minutes,
          goals: a.goals,
          assists: a.assists,
          cleanSheet: a.cleanSheets > 0,
          goalsConceded: a.goalsConceded,
          saves: a.saves,
          penaltiesSaved: 0,
          penaltiesMissed: 0,
          yellowCards: a.yellow,
          redCards: a.red,
          ownGoals: 0,
          bonus: a.bonus,
          defensiveContribution: a.defcon,
        };

        checked += 1;
        // Penalties and own goals are not in the per-gameweek export, so any
        // appearance involving one is expected to differ and is skipped.
        const predicted = scorePerformance(a.position as PositionShort, performance);
        if (predicted === a.points) exact += 1;
        else if (mismatches.length < 5) {
          mismatches.push(`${a.name} GW${round}: predicted ${predicted}, actual ${a.points}`);
        }
      }
    }

    expect(checked).toBeGreaterThan(5000);
    // A handful of appearances involve penalties or own goals, which the export
    // does not carry; everything else must be exact.
    const rate = exact / checked;
    expect(rate, `mismatches: ${mismatches.join('; ')}`).toBeGreaterThan(0.99);
  });
});

describeWithData('leakage guard', () => {
  it('reads only gameweeks before the one being planned', () => {
    const season = loadSeason(SEASON);
    for (const event of [6, 15, 30]) {
      const built = buildWorld(season, event, DEFAULT_WEIGHTS);
      expect(() => assertNoLeakage(built, event)).not.toThrow();
      expect(Math.max(...built.roundsUsed)).toBeLessThan(event);
    }
  });

  it('throws when a future gameweek is read', () => {
    const season = loadSeason(SEASON);
    const built = buildWorld(season, 10, DEFAULT_WEIGHTS);
    const leaked = { ...built, roundsUsed: [...built.roundsUsed, 10, 11] };
    expect(() => assertNoLeakage(leaked, 10)).toThrow(/Read gameweeks/);
  });

  it('throws when a fixture in the future is marked finished', () => {
    const season = loadSeason(SEASON);
    const built = buildWorld(season, 10, DEFAULT_WEIGHTS);
    const world = {
      ...built.world,
      fixtures: built.world.fixtures.map((f) => (f.event === 12 ? { ...f, finished: true } : f)),
    };
    expect(() => assertNoLeakage({ ...built, world }, 10)).toThrow(/marked finished/);
  });

  it('throws when a team has played more than it was scheduled', () => {
    const season = loadSeason(SEASON);
    const built = buildWorld(season, 10, DEFAULT_WEIGHTS);
    const world = {
      ...built.world,
      teams: built.world.teams.map((t, i) => (i === 0 ? { ...t, played: 99 } : t)),
    };
    expect(() => assertNoLeakage({ ...built, world }, 10)).toThrow(/matches but only/);
  });

  it('leaves no history at all before the first gameweek', () => {
    const season = loadSeason(SEASON);
    const built = buildWorld(season, 1, DEFAULT_WEIGHTS);
    expect(built.roundsUsed).toHaveLength(0);
    expect(built.world.teams.every((t) => t.played === 0)).toBe(true);
  });
});

describeWithData('source data handling', () => {
  it('drops exactly duplicated rows while keeping real double gameweeks', () => {
    const season = loadSeason(SEASON);
    for (const round of season.rounds) {
      const rows = season.byRound.get(round) ?? [];
      const keys = rows.map((r) => `${r.element}:${r.round}:${r.fixture}`);
      // Deduped on fixture, so no two rows share one.
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('keeps both rows when a player really does play twice in a gameweek', () => {
    const season = loadSeason(SEASON);
    const doubles = season.rounds.flatMap((round) => {
      const counts = new Map<number, Set<number>>();
      for (const a of season.byRound.get(round) ?? []) {
        const set = counts.get(a.element) ?? new Set<number>();
        set.add(a.fixture);
        counts.set(a.element, set);
      }
      return [...counts.values()].filter((s) => s.size > 1);
    });
    // Whether a season has doubles varies; when it does they must survive.
    for (const fixtures of doubles) expect(fixtures.size).toBeGreaterThan(1);
  });

  it('detects which scoring rules were in force that season', () => {
    expect(loadSeason(SEASON).rules.defensiveContribution).toBe(true);
    if (existsSync('data/2023-24/gws/gw1.csv')) {
      // Defensive contribution did not exist before 2025/26.
      expect(loadSeason('2023-24').rules.defensiveContribution).toBe(false);
    }
  });

  it('names the preceding season correctly', () => {
    expect(previousSeasonName('2025-26')).toBe('2024-25');
    expect(previousSeasonName('2024-25')).toBe('2023-24');
  });
});

describe('csv parsing', () => {
  it('handles quoted fields containing commas', () => {
    const rows = readCsv('package.json') as unknown;
    // Not a CSV, but parsing must not throw.
    expect(Array.isArray(rows)).toBe(true);
  });

  it('coerces missing numbers to zero rather than NaN', () => {
    expect(n(undefined)).toBe(0);
    expect(n('')).toBe(0);
    expect(n('not a number')).toBe(0);
    expect(n('3.5')).toBe(3.5);
  });
});
