import 'server-only';

import { FplError } from './client';
import type { PositionShort } from './types';

/**
 * Per-gameweek player history.
 *
 * `bootstrap-static` only carries season totals, but the projection model leans
 * heavily on a recent window -- who has actually been starting lately is the
 * strongest signal available. That detail lives on `element-summary`, one
 * request per player, so it is fetched only for the players a decision could
 * plausibly involve.
 */

const BASE = 'https://fantasy.premierleague.com/api';
const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

const TTL_SECONDS = 3600;
const CONCURRENCY = 8;

export interface HistoryRow {
  round: number;
  minutes: number;
  starts: number;
  goals: number;
  assists: number;
  xg: number;
  xa: number;
  cleanSheets: number;
  goalsConceded: number;
  saves: number;
  bonus: number;
  bps: number;
  defcon: number;
  yellow: number;
  red: number;
  points: number;
}

interface RawHistory {
  round: number;
  minutes: number;
  starts: number;
  goals_scored: number;
  assists: number;
  expected_goals: string;
  expected_assists: string;
  clean_sheets: number;
  goals_conceded: number;
  saves: number;
  bonus: number;
  bps: number;
  defensive_contribution: number;
  yellow_cards: number;
  red_cards: number;
  total_points: number;
}

const cache = new Map<number, { at: number; rows: HistoryRow[] }>();

const num = (v: string | number | null | undefined): number => {
  const parsed = typeof v === 'number' ? v : parseFloat(v ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
};

async function fetchOne(playerId: number): Promise<HistoryRow[]> {
  const hit = cache.get(playerId);
  if (hit && Date.now() - hit.at < TTL_SECONDS * 1000) return hit.rows;

  let res: Response;
  try {
    res = await fetch(`${BASE}/element-summary/${playerId}/`, {
      headers: HEADERS,
      next: { revalidate: TTL_SECONDS },
    });
  } catch {
    throw new FplError(`Could not reach the FPL API for player ${playerId}.`, 503);
  }

  if (!res.ok) throw new FplError(`History unavailable for player ${playerId}.`, res.status);

  const body = (await res.json()) as { history?: RawHistory[] };
  const rows: HistoryRow[] = (body.history ?? []).map((h) => ({
    round: h.round,
    minutes: h.minutes,
    starts: h.starts,
    goals: h.goals_scored,
    assists: h.assists,
    xg: num(h.expected_goals),
    xa: num(h.expected_assists),
    cleanSheets: h.clean_sheets,
    goalsConceded: h.goals_conceded,
    saves: h.saves,
    bonus: h.bonus,
    bps: h.bps,
    defcon: h.defensive_contribution,
    yellow: h.yellow_cards,
    red: h.red_cards,
    points: h.total_points,
  }));

  cache.set(playerId, { at: Date.now(), rows });
  return rows;
}

/**
 * Fetch histories for a set of players, a few at a time.
 *
 * A player whose history cannot be fetched is simply omitted -- the projection
 * falls back to season totals for them rather than the whole analysis failing.
 */
export async function fetchHistories(playerIds: number[]): Promise<Map<number, HistoryRow[]>> {
  const unique = [...new Set(playerIds)];
  const out = new Map<number, HistoryRow[]>();
  let cursor = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY, unique.length) }, async () => {
    while (cursor < unique.length) {
      const id = unique[cursor++];
      try {
        out.set(id, await fetchOne(id));
      } catch {
        // Leave it out; the caller degrades to season-only data.
      }
    }
  });

  await Promise.all(workers);
  return out;
}

/** Defensive-contribution thresholds, needed to count hits from raw tallies. */
export const DEFCON_THRESHOLDS: Record<PositionShort, number | null> = {
  GKP: null,
  DEF: 10,
  MID: 12,
  FWD: 12,
};
