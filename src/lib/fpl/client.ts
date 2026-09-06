import 'server-only';

import type {
  FplBootstrap,
  FplEntry,
  FplEntryHistory,
  FplFixture,
  FplPicksResponse,
} from './types';

const BASE = 'https://fantasy.premierleague.com/api';

/** The FPL API sits behind Cloudflare and rejects default fetch agents. */
const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en-GB,en;q=0.9',
};

/**
 * NO_SQUAD means the manager exists but the API will not hand over a squad --
 * they joined for a gameweek whose deadline has not passed yet, so their team
 * is only visible behind an authenticated session.
 */
export type FplErrorCode = 'NO_SQUAD' | 'NOT_FOUND' | 'UPSTREAM';

export class FplError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: FplErrorCode = 'UPSTREAM',
  ) {
    super(message);
    this.name = 'FplError';
  }
}

/**
 * In-process cache. Next's own fetch cache is unreliable in dev and for
 * dynamic route handlers, so this guarantees we never hammer the same
 * endpoint twice inside a TTL window.
 */
type CacheEntry = { at: number; value: unknown };
const memo = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * Whether a resource may sit in Next's persistent, cross-restart fetch cache.
 *
 * Shared reference data (players, fixtures) is slow-moving and safe to keep.
 * A manager's own entry, picks and history are not: they change the moment a
 * transfer is made or a gameweek ticks over, and a stale copy surviving a
 * restart is how this app once reported 0 points and no rank for a team that
 * had already played.
 */
type CacheMode = 'shared' | 'per-manager';

async function get<T>(
  path: string,
  ttlSeconds: number,
  mode: CacheMode = 'shared',
): Promise<T> {
  const key = path;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlSeconds * 1000) return hit.value as T;

  // Collapse concurrent requests for the same resource into one fetch.
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const task = (async () => {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        headers: HEADERS,
        // Per-manager data is only ever held in the short-lived in-process
        // memo above, which dies with the process and cannot go stale across
        // a restart or deploy.
        ...(mode === 'shared'
          ? { next: { revalidate: ttlSeconds } }
          : { cache: 'no-store' as const }),
      });
    } catch (cause) {
      throw new FplError(`Could not reach the FPL API (${path}).`, 503);
    }

    if (!res.ok) {
      if (res.status === 404) throw new FplError(`Not found: ${path}`, 404);
      throw new FplError(`FPL API returned ${res.status} for ${path}`, res.status);
    }

    const value = (await res.json()) as T;
    memo.set(key, { at: Date.now(), value });
    return value;
  })();

  inflight.set(key, task);
  try {
    return (await task) as T;
  } finally {
    inflight.delete(key);
  }
}

/** Players, teams, gameweeks and the chip catalogue. Changes at most hourly. */
export const getBootstrap = () => get<FplBootstrap>('/bootstrap-static/', 900);

/** All 380 fixtures with difficulty ratings. Effectively static within a week. */
export const getFixtures = () => get<FplFixture[]>('/fixtures/', 3600);

/** Manager account summary: name, rank, squad value, bank. */
export const getEntry = (managerId: number) =>
  get<FplEntry>(`/entry/${managerId}/`, 300);

/** The 15 picks for a given gameweek, plus that week's bank/value snapshot. */
export const getPicks = (managerId: number, event: number) =>
  get<FplPicksResponse>(`/entry/${managerId}/event/${event}/picks/`, 300);

/** Per-gameweek history — needed to derive free transfers and chips used. */
export const getEntryHistory = (managerId: number) =>
  get<FplEntryHistory>(`/entry/${managerId}/history/`, 300);

/** Test hook: drop everything so a fetch definitely hits the network. */
export function clearFplCache() {
  memo.clear();
}

/**
 * Drop one manager's cached responses, so an explicit refresh really does go
 * back to the FPL API rather than replaying the last minute's answer.
 */
export function invalidateManager(managerId: number) {
  const prefix = `/entry/${managerId}/`;
  for (const key of [...memo.keys()]) {
    if (key === prefix || key.startsWith(prefix)) memo.delete(key);
  }
}
