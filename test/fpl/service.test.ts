import { describe, expect, it } from 'vitest';

import {
  buildFixtureIndex,
  checkSquadLegality,
  deriveChips,
  deriveFreeTransfers,
  gamesPlayedSoFar,
  resolveEvents,
} from '@/lib/fpl/service';
import type {
  FplBootstrap,
  FplEntryHistory,
  FplEvent,
  FplFixture,
  FplTeam,
} from '@/lib/fpl/types';
import type { SquadPlayer } from '@/lib/fpl/model';
import { DEFAULT_WEIGHTS } from '@/lib/engine/weights';

/**
 * Two things here are derived rather than read, because the public API does not
 * expose them, and both have been wrong in ways that were easy to miss: free
 * transfers (an off-by-one at the season's start) and chip availability (which
 * runs on two half-season windows).
 */

const event = (over: Partial<FplEvent>): FplEvent => ({
  id: 1,
  name: 'Gameweek 1',
  deadline_time: '2026-08-21T17:30:00Z',
  deadline_time_epoch: 1,
  finished: false,
  is_current: false,
  is_next: false,
  is_previous: false,
  average_entry_score: 0,
  highest_score: null,
  ...over,
});

const historyRow = (round: number, transfers: number) => ({
  event: round,
  points: 50,
  total_points: 50,
  rank: 1,
  overall_rank: 1,
  bank: 0,
  value: 1000,
  event_transfers: transfers,
  event_transfers_cost: 0,
  points_on_bench: 0,
});

const history = (
  rows: { event: number; transfers: number }[],
  chips: { name: string; event: number }[] = [],
): FplEntryHistory => ({
  current: rows.map((r) => historyRow(r.event, r.transfers)),
  past: [],
  chips: chips.map((c) => ({ ...c, time: '' })),
});

describe('free transfers', () => {
  it('gives exactly one entering the first playable gameweek', () => {
    // Regression: an earlier version counted the joining gameweek itself, which
    // reported three free transfers at GW3 when the real answer was two.
    expect(deriveFreeTransfers(history([{ event: 1, transfers: 0 }]), 1, 2)).toBe(1);
  });

  it('banks an unused transfer each week', () => {
    const rows = history([
      { event: 1, transfers: 0 },
      { event: 2, transfers: 0 },
    ]);
    expect(deriveFreeTransfers(rows, 1, 3)).toBe(2);
    expect(
      deriveFreeTransfers(
        history([
          { event: 1, transfers: 0 },
          { event: 2, transfers: 0 },
          { event: 3, transfers: 0 },
        ]),
        1,
        4,
      ),
    ).toBe(3);
  });

  it('caps the bank at five', () => {
    const rows = history(Array.from({ length: 12 }, (_, i) => ({ event: i + 1, transfers: 0 })));
    expect(deriveFreeTransfers(rows, 1, 13)).toBe(5);
  });

  it('spends what was used and never drops below one', () => {
    const rows = history([
      { event: 1, transfers: 0 },
      { event: 2, transfers: 1 },
    ]);
    expect(deriveFreeTransfers(rows, 1, 3)).toBe(1);

    // Three transfers on one free is a hit; the count floors at zero, then the
    // weekly grant brings it back to one.
    const hit = history([
      { event: 1, transfers: 0 },
      { event: 2, transfers: 3 },
    ]);
    expect(deriveFreeTransfers(hit, 1, 3)).toBe(1);
  });

  it('preserves banked transfers through a wildcard or free hit', () => {
    for (const chip of ['wildcard', 'freehit']) {
      const rows = history(
        [
          { event: 1, transfers: 0 },
          { event: 2, transfers: 8 },
        ],
        [{ name: chip, event: 2 }],
      );
      // The eight transfers were free, so the bank is untouched and grows.
      expect(deriveFreeTransfers(rows, 1, 3)).toBe(2);
    }
  });

  it('handles a manager who joined mid-season', () => {
    const rows = history([
      { event: 5, transfers: 0 },
      { event: 6, transfers: 0 },
    ]);
    expect(deriveFreeTransfers(rows, 5, 6)).toBe(1);
    expect(deriveFreeTransfers(rows, 5, 7)).toBe(2);
  });
});

describe('chip availability', () => {
  const bootstrap = {
    chips: [
      { id: 1, name: 'wildcard', number: 1, start_event: 2, stop_event: 19, chip_type: 'transfer' },
      { id: 2, name: 'wildcard', number: 1, start_event: 20, stop_event: 38, chip_type: 'transfer' },
      { id: 3, name: 'freehit', number: 1, start_event: 2, stop_event: 19, chip_type: 'transfer' },
      { id: 4, name: 'bboost', number: 1, start_event: 1, stop_event: 19, chip_type: 'team' },
      { id: 5, name: '3xc', number: 1, start_event: 1, stop_event: 19, chip_type: 'team' },
      { id: 6, name: 'bboost', number: 1, start_event: 20, stop_event: 38, chip_type: 'team' },
    ],
  } as unknown as FplBootstrap;

  it('offers every chip whose window covers the gameweek', () => {
    const { available } = deriveChips(bootstrap, history([]), 3);
    expect(available.sort()).toEqual(['3xc', 'bboost', 'freehit', 'wildcard'].sort());
  });

  it('removes a chip already played in that half of the season', () => {
    const played = history([], [{ name: 'bboost', event: 1 }]);
    const { available, used } = deriveChips(bootstrap, played, 3);
    expect(available).not.toContain('bboost');
    expect(used).toEqual([{ name: 'bboost', event: 1 }]);
  });

  it('restores a chip in the second half after it was used in the first', () => {
    // Bench Boost used in GW1 is spent for GW1-19, but GW20-38 has its own.
    const played = history([], [{ name: 'bboost', event: 1 }]);
    expect(deriveChips(bootstrap, played, 25).available).toContain('bboost');
  });

  it('offers nothing outside a chip window', () => {
    // Free Hit only has a first-half entry in this fixture.
    expect(deriveChips(bootstrap, history([]), 25).available).not.toContain('freehit');
  });
});

describe('gameweek resolution', () => {
  it('plans for the next gameweek and reads the squad from the current one', () => {
    const events = [
      event({ id: 1, finished: true, is_previous: true }),
      event({ id: 2, is_current: true }),
      event({ id: 3, is_next: true }),
    ];
    expect(resolveEvents(events)).toEqual({ target: events[2], source: 2 });
  });

  it('falls back to the current gameweek once the season has no next', () => {
    const events = [event({ id: 37, finished: true }), event({ id: 38, is_current: true })];
    expect(resolveEvents(events).target.id).toBe(38);
  });

  it('counts finished gameweeks, never returning zero', () => {
    expect(gamesPlayedSoFar([event({ finished: true }), event({ finished: false })])).toBe(1);
    expect(gamesPlayedSoFar([event({ finished: false })])).toBe(1);
  });
});

describe('fixture index', () => {
  const teams = [
    { id: 1, short_name: 'AAA' },
    { id: 2, short_name: 'BBB' },
    { id: 3, short_name: 'CCC' },
  ] as FplTeam[];

  const fixture = (over: Partial<FplFixture>): FplFixture =>
    ({
      id: 1,
      code: 1,
      event: 5,
      finished: false,
      kickoff_time: '2026-09-01T12:00:00Z',
      team_h: 1,
      team_a: 2,
      team_h_score: null,
      team_a_score: null,
      team_h_difficulty: 3,
      team_a_difficulty: 4,
      ...over,
    }) as FplFixture;

  it('records both sides with the right home flag and difficulty', () => {
    const index = buildFixtureIndex([fixture({})], teams, 5, DEFAULT_WEIGHTS.horizon);
    expect(index.get(1)?.[0]).toMatchObject({ opponent: 'BBB', isHome: true, difficulty: 3 });
    expect(index.get(2)?.[0]).toMatchObject({ opponent: 'AAA', isHome: false, difficulty: 4 });
  });

  it('keeps both matches of a double gameweek', () => {
    const index = buildFixtureIndex(
      [fixture({ id: 1 }), fixture({ id: 2, team_a: 3 })],
      teams,
      5,
      DEFAULT_WEIGHTS.horizon,
    );
    expect(index.get(1)).toHaveLength(2);
  });

  it('leaves a blank gameweek with no entry at all', () => {
    const index = buildFixtureIndex([fixture({ team_h: 2, team_a: 3 })], teams, 5, 5);
    expect(index.get(1)).toBeUndefined();
  });

  it('ignores finished fixtures and anything past the horizon', () => {
    const index = buildFixtureIndex(
      [fixture({ finished: true }), fixture({ id: 2, event: 99 })],
      teams,
      5,
      5,
    );
    expect(index.size).toBe(0);
  });
});

describe('manual squad legality', () => {
  const player = (position: SquadPlayer['position'], teamShort: string, price: number) =>
    ({ position, teamShort, price }) as SquadPlayer;

  const legal = () => [
    ...Array.from({ length: 2 }, (_, i) => player('GKP', `G${i}`, 4.5)),
    ...Array.from({ length: 5 }, (_, i) => player('DEF', `D${i}`, 5)),
    ...Array.from({ length: 5 }, (_, i) => player('MID', `M${i}`, 6)),
    ...Array.from({ length: 3 }, (_, i) => player('FWD', `F${i}`, 7)),
  ];

  it('accepts a legal squad', () => {
    expect(checkSquadLegality(legal())).toBeNull();
  });

  it('rejects the wrong number in a position', () => {
    const squad = legal();
    squad[0] = player('DEF', 'X', 5);
    expect(checkSquadLegality(squad)).toMatch(/GKP/);
  });

  it('rejects a fourth player from one club', () => {
    const squad = legal();
    for (let i = 2; i < 6; i++) squad[i] = player('DEF', 'SAME', 5);
    expect(checkSquadLegality(squad)).toMatch(/only have 3 players from one club/);
  });

  it('rejects a squad over budget', () => {
    const squad = legal().map((p) => ({ ...p, price: 10 }) as SquadPlayer);
    expect(checkSquadLegality(squad)).toMatch(/over the 100.0m budget/);
  });
});
