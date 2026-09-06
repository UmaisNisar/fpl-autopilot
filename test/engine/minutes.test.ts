import { describe, expect, it } from 'vitest';

import { availabilityFactor, isPlayableStarter, modelMinutes } from '@/lib/engine/minutes';
import { emptyStatLine, type PlayerState, type StatLine } from '@/lib/engine/types';
import { DEFAULT_WEIGHTS, type Weights } from '@/lib/engine/weights';

/**
 * Expected minutes is the highest-leverage part of the projection, and the part
 * that has caused the most trouble: twice a weight of zero failed to actually
 * switch a prior off, which invalidated an A/B before anyone noticed. Those are
 * regression-tested here explicitly.
 */

function line(over: Partial<StatLine>): StatLine {
  return { ...emptyStatLine(), ...over };
}

function player(over: Partial<PlayerState> = {}): PlayerState {
  return {
    id: 1,
    name: 'Test',
    position: 'MID',
    teamId: 1,
    price: 6,
    status: 'a',
    chanceOfPlaying: null,
    news: '',
    season: emptyStatLine(),
    recent: emptyStatLine(),
    teamGames: 10,
    ...over,
  };
}

describe('availability', () => {
  it('reads the explicit chance of playing when FPL publishes one', () => {
    expect(availabilityFactor(player({ chanceOfPlaying: 75 }))).toBe(0.75);
    expect(availabilityFactor(player({ chanceOfPlaying: 0 }))).toBe(0);
    // An explicit chance wins over the status flag.
    expect(availabilityFactor(player({ status: 'i', chanceOfPlaying: 50 }))).toBe(0.5);
  });

  it('falls back to the status flag', () => {
    expect(availabilityFactor(player({ status: 'a' }))).toBe(1);
    expect(availabilityFactor(player({ status: 'd' }))).toBe(0.5);
    for (const status of ['i', 's', 'u', 'n']) {
      expect(availabilityFactor(player({ status }))).toBe(0);
    }
  });

  it('drives expected minutes to zero for an unavailable player', () => {
    const injured = player({
      status: 'i',
      teamGames: 10,
      season: line({ games: 10, starts: 10, appearances: 10, minutes: 900 }),
      recent: line({ games: 5, starts: 5, appearances: 5, minutes: 450 }),
    });
    const model = modelMinutes(injured, DEFAULT_WEIGHTS);
    expect(model.expectedMinutes).toBe(0);
    expect(model.startProbability).toBe(0);
    expect(isPlayableStarter(model)).toBe(false);
  });
});

describe('selection', () => {
  const nailed = player({
    teamGames: 10,
    season: line({ games: 10, starts: 10, appearances: 10, minutes: 900 }),
    recent: line({ games: 5, starts: 5, appearances: 5, minutes: 450 }),
  });

  const dropped = player({
    teamGames: 10,
    // Started early, then stopped being picked entirely.
    season: line({ games: 10, starts: 5, appearances: 5, minutes: 450 }),
    recent: line({ games: 5, starts: 0, appearances: 0, minutes: 0 }),
  });

  it('rates a nailed starter far above a dropped one', () => {
    const a = modelMinutes(nailed, DEFAULT_WEIGHTS);
    const b = modelMinutes(dropped, DEFAULT_WEIGHTS);
    expect(a.startProbability).toBeGreaterThan(0.75);
    expect(b.startProbability).toBeLessThan(0.2);
    expect(a.expectedMinutes).toBeGreaterThan(b.expectedMinutes * 4);
  });

  it('still holds a nailed starter short of certainty', () => {
    // Ten starts from ten is not enough to reach 1.0, because the prior is
    // worth 1.5 games at a 5% start rate. That deliberate caution is a large
    // part of why the raw model under-calls, and why the calibration layer in
    // `weights.calibrationSlope` exists. Pinned here so the interaction is not
    // changed by accident: loosening the prior means refitting calibration.
    const model = modelMinutes(nailed, DEFAULT_WEIGHTS);
    expect(model.startProbability).toBeGreaterThan(0.75);
    expect(model.startProbability).toBeLessThan(0.85);
  });

  it('weights recent evidence above older evidence', () => {
    // Same season totals; only the ordering differs.
    const fadingOut = player({
      teamGames: 10,
      season: line({ games: 10, starts: 5, appearances: 5, minutes: 450 }),
      recent: line({ games: 5, starts: 0, appearances: 0, minutes: 0 }),
    });
    const breakingIn = player({
      teamGames: 10,
      season: line({ games: 10, starts: 5, appearances: 5, minutes: 450 }),
      recent: line({ games: 5, starts: 5, appearances: 5, minutes: 450 }),
    });
    expect(modelMinutes(breakingIn, DEFAULT_WEIGHTS).startProbability).toBeGreaterThan(
      modelMinutes(fadingOut, DEFAULT_WEIGHTS).startProbability,
    );
  });

  it('never rates appearing as less likely than starting', () => {
    for (const p of [nailed, dropped]) {
      const model = modelMinutes(p, DEFAULT_WEIGHTS);
      expect(model.playProbability).toBeGreaterThanOrEqual(model.startProbability);
    }
  });

  it('does not treat an unknown player as startable', () => {
    const unknown = player({ teamGames: 0 });
    expect(modelMinutes(unknown, DEFAULT_WEIGHTS).startProbability).toBeLessThan(0.5);
  });

  it('gates the clean-sheet hour behind starting', () => {
    const model = modelMinutes(nailed, DEFAULT_WEIGHTS);
    expect(model.sixtyProbability).toBeLessThanOrEqual(model.startProbability);
    expect(model.sixtyProbability).toBeGreaterThan(0);
  });

  it('lowers the clean-sheet hour for a habitual early substitution', () => {
    const fullMatches = player({
      teamGames: 10,
      season: line({ games: 10, starts: 10, appearances: 10, minutes: 900 }),
      recent: line({ games: 5, starts: 5, appearances: 5, minutes: 450 }),
    });
    const alwaysHooked = player({
      teamGames: 10,
      season: line({ games: 10, starts: 10, appearances: 10, minutes: 550 }),
      recent: line({ games: 5, starts: 5, appearances: 5, minutes: 275 }),
    });
    expect(modelMinutes(alwaysHooked, DEFAULT_WEIGHTS).sixtyProbability).toBeLessThan(
      modelMinutes(fullMatches, DEFAULT_WEIGHTS).sixtyProbability,
    );
  });
});

describe('last season as a selection prior', () => {
  const withLastSeason = player({
    teamGames: 2,
    season: line({ games: 2, starts: 0, appearances: 0, minutes: 0 }),
    recent: line({ games: 2, starts: 0, appearances: 0, minutes: 0 }),
    previous: line({ games: 38, starts: 38, appearances: 38, minutes: 3400 }),
    previousTeamGames: 38,
  });

  it('is genuinely ignored at zero weight, not merely down-weighted', () => {
    // This is a regression test. A previous version swapped in last season's
    // rate as the prior *value* even at zero weight, so the switch that decided
    // whether the feature earned its place did not actually switch anything --
    // and the resulting A/B was wrong.
    const off: Weights = { ...DEFAULT_WEIGHTS, previousStartWeight: 0 };
    const withPrevious = modelMinutes(withLastSeason, off);
    const withoutPrevious = modelMinutes(
      player({ ...withLastSeason, previous: undefined, previousTeamGames: undefined }),
      off,
    );
    expect(withPrevious.startProbability).toBeCloseTo(withoutPrevious.startProbability, 10);
  });

  it('lifts a benched player toward last season when weighted on', () => {
    const on: Weights = { ...DEFAULT_WEIGHTS, previousStartWeight: 0.5 };
    const off: Weights = { ...DEFAULT_WEIGHTS, previousStartWeight: 0 };
    expect(modelMinutes(withLastSeason, on).startProbability).toBeGreaterThan(
      modelMinutes(withLastSeason, off).startProbability,
    );
  });

  it('is shipped switched off, because it cost more ranking than it bought', () => {
    expect(DEFAULT_WEIGHTS.previousStartWeight).toBe(0);
    expect(DEFAULT_WEIGHTS.previousSeasonWeight).toBe(0);
  });
});
