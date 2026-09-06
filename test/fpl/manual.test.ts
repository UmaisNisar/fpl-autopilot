import { afterEach, describe, expect, it } from 'vitest';

import { isManagerAllowed, parseManualSquad, SQUAD_SIZE } from '@/lib/fpl/manual';

/**
 * The gate on everything a client can send. A public deployment of a
 * single-user tool depends on `isManagerAllowed`, and every manual squad that
 * reaches the engine comes through `parseManualSquad`.
 */

const ids = Array.from({ length: SQUAD_SIZE }, (_, i) => i + 1);

describe('parsing a manual squad', () => {
  it('accepts fifteen distinct players', () => {
    const squad = parseManualSquad({ playerIds: ids, captainId: 1, viceCaptainId: 2 });
    expect(squad?.playerIds).toEqual(ids);
    expect(squad?.captainId).toBe(1);
    expect(squad?.viceCaptainId).toBe(2);
  });

  it('rejects anything that is not fifteen distinct players', () => {
    expect(parseManualSquad({ playerIds: ids.slice(0, 14) })).toBeNull();
    expect(parseManualSquad({ playerIds: [...ids, 16] })).toBeNull();
    expect(parseManualSquad({ playerIds: [...ids.slice(0, 14), 1] })).toBeNull();
  });

  it('rejects junk rather than throwing', () => {
    for (const value of [null, undefined, 'squad', 42, [], {}, { playerIds: 'nope' }]) {
      expect(parseManualSquad(value)).toBeNull();
    }
  });

  it('discards ids that are not positive integers', () => {
    expect(parseManualSquad({ playerIds: [...ids.slice(0, 14), -1] })).toBeNull();
    expect(parseManualSquad({ playerIds: [...ids.slice(0, 14), 'x'] })).toBeNull();
  });

  it('ignores a captain who is not in the squad', () => {
    const squad = parseManualSquad({ playerIds: ids, captainId: 999, viceCaptainId: 3 });
    expect(squad?.captainId).toBeNull();
    expect(squad?.viceCaptainId).toBe(3);
  });

  it('takes a stated bank, and leaves it undefined when absent or invalid', () => {
    // Bank cannot be derived from current prices, because FPL locks in what you
    // paid: a player rising 0.1m raises squad value without touching the bank.
    expect(parseManualSquad({ playerIds: ids, bank: 4.2 })?.bank).toBe(4.2);
    expect(parseManualSquad({ playerIds: ids, bank: 0 })?.bank).toBe(0);
    expect(parseManualSquad({ playerIds: ids })?.bank).toBeUndefined();
    expect(parseManualSquad({ playerIds: ids, bank: -1 })?.bank).toBeUndefined();
    expect(parseManualSquad({ playerIds: ids, bank: 'lots' })?.bank).toBeUndefined();
  });

  it('rounds the bank to a tenth of a million', () => {
    expect(parseManualSquad({ playerIds: ids, bank: 4.23456 })?.bank).toBe(4.2);
  });

  it('takes a stated free-transfer count within the range the game allows', () => {
    // Derived free transfers go stale the moment a transfer is made for a
    // gameweek that has not kicked off, so a correction can override them.
    expect(parseManualSquad({ playerIds: ids, freeTransfers: 0 })?.freeTransfers).toBe(0);
    expect(parseManualSquad({ playerIds: ids, freeTransfers: 5 })?.freeTransfers).toBe(5);
    expect(parseManualSquad({ playerIds: ids })?.freeTransfers).toBeUndefined();
    // Outside what the game allows, or not a whole number.
    expect(parseManualSquad({ playerIds: ids, freeTransfers: 6 })?.freeTransfers).toBeUndefined();
    expect(parseManualSquad({ playerIds: ids, freeTransfers: -1 })?.freeTransfers).toBeUndefined();
    expect(parseManualSquad({ playerIds: ids, freeTransfers: 1.5 })?.freeTransfers).toBeUndefined();
  });

  it('records the gameweek a correction was made for', () => {
    // A correction describes one gameweek and expires with it; without this
    // the app would keep showing a squad the API has since caught up on.
    expect(parseManualSquad({ playerIds: ids, forEvent: 4 })?.forEvent).toBe(4);
    expect(parseManualSquad({ playerIds: ids })?.forEvent).toBeUndefined();
    expect(parseManualSquad({ playerIds: ids, forEvent: 0 })?.forEvent).toBeUndefined();
    expect(parseManualSquad({ playerIds: ids, forEvent: 'four' })?.forEvent).toBeUndefined();
  });
});

describe('deployment manager lock', () => {
  const original = process.env.ALLOWED_MANAGER_IDS;
  afterEach(() => {
    if (original === undefined) delete process.env.ALLOWED_MANAGER_IDS;
    else process.env.ALLOWED_MANAGER_IDS = original;
  });

  it('allows everyone when unset, which is what local development wants', () => {
    delete process.env.ALLOWED_MANAGER_IDS;
    expect(isManagerAllowed(1)).toBe(true);
    expect(isManagerAllowed(999999)).toBe(true);

    process.env.ALLOWED_MANAGER_IDS = '   ';
    expect(isManagerAllowed(1)).toBe(true);
  });

  it('admits only the listed managers once set', () => {
    process.env.ALLOWED_MANAGER_IDS = '10189764';
    expect(isManagerAllowed(10189764)).toBe(true);
    expect(isManagerAllowed(1234567)).toBe(false);
  });

  it('accepts a list, ignoring whitespace and junk entries', () => {
    process.env.ALLOWED_MANAGER_IDS = ' 1, 2 ,notanumber, 3 ';
    expect(isManagerAllowed(1)).toBe(true);
    expect(isManagerAllowed(3)).toBe(true);
    expect(isManagerAllowed(4)).toBe(false);
  });
});
