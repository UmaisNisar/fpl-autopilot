import { describe, expect, it } from 'vitest';

import {
  DEFCON_THRESHOLD,
  scorePerformance,
  TRANSFER_HIT_COST,
  type Performance,
} from '@/lib/engine/scoring';
import type { PositionShort } from '@/lib/fpl/types';

/**
 * The scoring rules are the one thing in the engine that is not a model: they
 * are the game's own arithmetic, and everything downstream is meaningless if
 * they are wrong. `test/backtest/scoring-conformance.test.ts` checks them
 * against a full real season; these cover the branches directly.
 */

const blank: Performance = {
  minutes: 0,
  goals: 0,
  assists: 0,
  cleanSheet: false,
  goalsConceded: 0,
  saves: 0,
  penaltiesSaved: 0,
  penaltiesMissed: 0,
  yellowCards: 0,
  redCards: 0,
  ownGoals: 0,
  bonus: 0,
  defensiveContribution: 0,
};

const perf = (over: Partial<Performance>): Performance => ({ ...blank, ...over });

describe('appearance points', () => {
  it('scores nothing for a player who did not play', () => {
    for (const pos of ['GKP', 'DEF', 'MID', 'FWD'] as PositionShort[]) {
      expect(scorePerformance(pos, perf({ minutes: 0, goals: 3 }))).toBe(0);
    }
  });

  it('gives one point under the hour and two from the hour', () => {
    expect(scorePerformance('MID', perf({ minutes: 1 }))).toBe(1);
    expect(scorePerformance('MID', perf({ minutes: 59 }))).toBe(1);
    expect(scorePerformance('MID', perf({ minutes: 60 }))).toBe(2);
    expect(scorePerformance('MID', perf({ minutes: 90 }))).toBe(2);
  });
});

describe('goals and assists', () => {
  it('pays goals by position', () => {
    const one = perf({ minutes: 90, goals: 1 });
    expect(scorePerformance('GKP', one)).toBe(2 + 6);
    expect(scorePerformance('DEF', one)).toBe(2 + 6);
    expect(scorePerformance('MID', one)).toBe(2 + 5);
    expect(scorePerformance('FWD', one)).toBe(2 + 4);
  });

  it('pays every assist the same three points', () => {
    for (const pos of ['GKP', 'DEF', 'MID', 'FWD'] as PositionShort[]) {
      const base = scorePerformance(pos, perf({ minutes: 90 }));
      expect(scorePerformance(pos, perf({ minutes: 90, assists: 2 }))).toBe(base + 6);
    }
  });
});

describe('clean sheets', () => {
  it('pays defenders and keepers four, midfielders one, forwards nothing', () => {
    const cs = perf({ minutes: 90, cleanSheet: true });
    expect(scorePerformance('GKP', cs)).toBe(2 + 4);
    expect(scorePerformance('DEF', cs)).toBe(2 + 4);
    expect(scorePerformance('MID', cs)).toBe(2 + 1);
    expect(scorePerformance('FWD', cs)).toBe(2);
  });

  it('withholds it from a player substituted before the hour', () => {
    expect(scorePerformance('DEF', perf({ minutes: 59, cleanSheet: true }))).toBe(1);
  });
});

describe('goals conceded', () => {
  it('docks a point per two conceded, for keepers and defenders only', () => {
    const two = perf({ minutes: 90, goalsConceded: 2 });
    expect(scorePerformance('GKP', two)).toBe(2 - 1);
    expect(scorePerformance('DEF', two)).toBe(2 - 1);
    expect(scorePerformance('MID', two)).toBe(2);
    expect(scorePerformance('FWD', two)).toBe(2);
  });

  it('rounds down, so a single goal costs nothing', () => {
    expect(scorePerformance('DEF', perf({ minutes: 90, goalsConceded: 1 }))).toBe(2);
    expect(scorePerformance('DEF', perf({ minutes: 90, goalsConceded: 3 }))).toBe(2 - 1);
  });
});

describe('goalkeeping', () => {
  it('pays one point per three saves, rounding down', () => {
    expect(scorePerformance('GKP', perf({ minutes: 90, saves: 2 }))).toBe(2);
    expect(scorePerformance('GKP', perf({ minutes: 90, saves: 3 }))).toBe(3);
    expect(scorePerformance('GKP', perf({ minutes: 90, saves: 8 }))).toBe(4);
  });

  it('pays saves only to goalkeepers', () => {
    expect(scorePerformance('DEF', perf({ minutes: 90, saves: 9 }))).toBe(2);
  });

  it('pays five for a saved penalty', () => {
    expect(scorePerformance('GKP', perf({ minutes: 90, penaltiesSaved: 1 }))).toBe(7);
  });
});

describe('defensive contribution', () => {
  it('pays two points at the position threshold', () => {
    expect(scorePerformance('DEF', perf({ minutes: 90, defensiveContribution: 9 }))).toBe(2);
    expect(scorePerformance('DEF', perf({ minutes: 90, defensiveContribution: 10 }))).toBe(4);
    expect(scorePerformance('MID', perf({ minutes: 90, defensiveContribution: 11 }))).toBe(2);
    expect(scorePerformance('MID', perf({ minutes: 90, defensiveContribution: 12 }))).toBe(4);
    expect(scorePerformance('FWD', perf({ minutes: 90, defensiveContribution: 12 }))).toBe(4);
  });

  it('never pays a goalkeeper, however many actions', () => {
    expect(DEFCON_THRESHOLD.GKP).toBeNull();
    expect(scorePerformance('GKP', perf({ minutes: 90, defensiveContribution: 40 }))).toBe(2);
  });

  it('pays a flat two, not per action', () => {
    const a = scorePerformance('DEF', perf({ minutes: 90, defensiveContribution: 10 }));
    const b = scorePerformance('DEF', perf({ minutes: 90, defensiveContribution: 30 }));
    expect(a).toBe(b);
  });
});

describe('penalties and cards', () => {
  it('applies each deduction', () => {
    expect(scorePerformance('FWD', perf({ minutes: 90, penaltiesMissed: 1 }))).toBe(0);
    expect(scorePerformance('MID', perf({ minutes: 90, yellowCards: 1 }))).toBe(1);
    expect(scorePerformance('MID', perf({ minutes: 90, redCards: 1 }))).toBe(-1);
    expect(scorePerformance('DEF', perf({ minutes: 90, ownGoals: 1 }))).toBe(0);
  });

  it('can produce a negative total', () => {
    expect(
      scorePerformance('DEF', perf({ minutes: 90, redCards: 1, ownGoals: 1, goalsConceded: 4 })),
    ).toBeLessThan(0);
  });
});

describe('bonus', () => {
  it('adds straight through', () => {
    expect(scorePerformance('FWD', perf({ minutes: 90, bonus: 3 }))).toBe(5);
  });
});

it('charges four points per transfer beyond the free allowance', () => {
  expect(TRANSFER_HIT_COST).toBe(4);
});
