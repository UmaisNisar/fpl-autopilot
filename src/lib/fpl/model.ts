/**
 * The app's own domain model. Shared by server and client, so nothing here
 * imports `server-only` or the raw API types' quirks (strings-as-numbers etc).
 */

import type { PositionShort } from './types';

export type ChipKey = 'wildcard' | 'freehit' | 'bboost' | '3xc';

export const CHIP_LABELS: Record<ChipKey, string> = {
  wildcard: 'Wildcard',
  freehit: 'Free Hit',
  bboost: 'Bench Boost',
  '3xc': 'Triple Captain',
};

export interface FixtureLite {
  event: number;
  opponent: string;
  isHome: boolean;
  difficulty: number;
  kickoff: string | null;
}

export interface SquadPlayer {
  id: number;
  name: string;
  fullName: string;
  position: PositionShort;
  teamShort: string;
  teamName: string;
  teamCode: number;
  price: number;
  /** Pick slot 1-15; 1-11 were the starters at the last deadline. */
  slot: number;
  isStarter: boolean;
  isCaptain: boolean;
  isViceCaptain: boolean;
  totalPoints: number;
  form: number;
  pointsPerGame: number;
  minutes: number;
  starts: number;
  goals: number;
  assists: number;
  bonus: number;
  xgi90: number;
  xgc90: number;
  defcon90: number;
  /** a=available, d=doubtful, i=injured, s=suspended, u=unavailable */
  status: string;
  news: string;
  chanceOfPlaying: number | null;
  selectedBy: number;
  epNext: number;
  fixtures: FixtureLite[];
  /** Mean fixture difficulty across the planning horizon. */
  fdr: number;
  /** Our own heuristic points projection across the horizon. */
  projected: number;
  /** Our own heuristic points projection for the next gameweek only. */
  projNext: number;
}

export interface GameweekInfo {
  id: number;
  name: string;
  deadline: string;
  deadlineEpoch: number;
  /** The gameweek whose picks we read the squad from. */
  sourceEvent: number;
  averageScore: number | null;
}

/** Where the squad on screen came from, and therefore how current it is. */
export type SquadSource =
  /** Read from the API: the team as it stood at the last deadline. */
  | 'last-deadline'
  /** Corrected by hand, for the upcoming gameweek. */
  | 'entered';

export interface TeamSnapshot {
  manager: {
    id: number;
    name: string;
    teamName: string;
    overallPoints: number;
    overallRank: number | null;
    gwPoints: number;
    gwRank: number | null;
  };
  gameweek: GameweekInfo;
  finances: {
    teamValue: number;
    bank: number;
    freeTransfers: number;
    /** True when we inferred FTs from history rather than reading them. */
    freeTransfersInferred: boolean;
    /**
     * True before a manager's first deadline, when the whole team can still be
     * changed for free. Transfers are unlimited and no hit can apply.
     */
    unlimitedTransfers: boolean;
  };
  chips: {
    available: ChipKey[];
    used: { name: ChipKey; event: number }[];
  };
  squad: SquadPlayer[];
  fetchedAt: string;
  /** True when the squad came from manual entry rather than the API. */
  manualSquad: boolean;
  /**
   * How current the squad is.
   *
   * FPL does not publish transfers made for an upcoming gameweek -- they appear
   * only once that deadline passes -- so an API-sourced squad is always the
   * team as it stood at the *last* deadline, not necessarily as it stands now.
   */
  squadSource: SquadSource;
}

/** A squad the manager typed in, because the API cannot expose theirs yet. */
export interface ManualSquad {
  /** Exactly 15 player ids, in pick order: 11 starters then 4 bench. */
  playerIds: number[];
  captainId: number | null;
  viceCaptainId: number | null;
  /**
   * Money in the bank, in millions.
   *
   * Cannot be derived from current prices: FPL locks in what you paid, so a
   * player rising 0.1m raises your squad value without touching your bank.
   * Deriving it would quietly under-report the budget by the total rise.
   */
  bank?: number;
  /** Free transfers remaining, when the derived figure is out of date. */
  freeTransfers?: number;
  /**
   * The gameweek this squad describes.
   *
   * A correction is only valid for the gameweek it was made for. Once that
   * deadline passes the API knows the real team, and holding on to a
   * hand-entered one would show a squad that has since changed.
   */
  forEvent?: number;
}

export const POSITION_ORDER: PositionShort[] = ['GKP', 'DEF', 'MID', 'FWD'];

/** Formation constraints for a legal starting XI. */
export const FORMATION_RULES: Record<PositionShort, { min: number; max: number }> = {
  GKP: { min: 1, max: 1 },
  DEF: { min: 3, max: 5 },
  MID: { min: 2, max: 5 },
  FWD: { min: 1, max: 3 },
};

export function formatMoney(tenths: number): string {
  return `£${(tenths / 10).toFixed(1)}m`;
}

export function formatPrice(millions: number): string {
  return `£${millions.toFixed(1)}m`;
}

export function formatRank(rank: number | null): string {
  if (rank === null || rank === undefined) return '—';
  return rank.toLocaleString('en-GB');
}
