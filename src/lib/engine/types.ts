import type { PositionShort } from '@/lib/fpl/types';

/**
 * The engine's own view of the world.
 *
 * Deliberately source-agnostic: the live app maps the FPL API into these
 * shapes, and the backtester maps historical CSVs into the same shapes. That
 * is what makes the backtest a real test of the engine rather than of a
 * parallel reimplementation.
 */

/** Accumulated statistics over some set of appearances. */
export interface StatLine {
  games: number;
  minutes: number;
  starts: number;
  appearances: number;
  goals: number;
  assists: number;
  xg: number;
  xa: number;
  cleanSheets: number;
  goalsConceded: number;
  saves: number;
  bonus: number;
  bps: number;
  /** Raw defensive-action tally across the period. */
  defcon: number;
  /** Appearances in which the defensive-contribution threshold was met. */
  defconHits: number;
  yellow: number;
  red: number;
  points: number;
}

export function emptyStatLine(): StatLine {
  return {
    games: 0,
    minutes: 0,
    starts: 0,
    appearances: 0,
    goals: 0,
    assists: 0,
    xg: 0,
    xa: 0,
    cleanSheets: 0,
    goalsConceded: 0,
    saves: 0,
    bonus: 0,
    bps: 0,
    defcon: 0,
    defconHits: 0,
    yellow: 0,
    red: 0,
    points: 0,
  };
}

export interface PlayerState {
  id: number;
  name: string;
  position: PositionShort;
  teamId: number;
  /** Millions. */
  price: number;
  /** a=available d=doubtful i=injured s=suspended u=unavailable n=not in squad */
  status: string;
  chanceOfPlaying: number | null;
  news: string;
  /** Everything so far this season. */
  season: StatLine;
  /** The last few gameweeks only, for rotation and form. */
  recent: StatLine;
  /** Gameweeks the player's club has played, the denominator for start share. */
  teamGames: number;
}

export interface TeamState {
  id: number;
  shortName: string;
  name: string;
  /** Matches played so far. */
  played: number;
  goalsFor: number;
  goalsAgainst: number;
  xgFor: number;
  xgAgainst: number;
}

export interface FixtureState {
  event: number;
  teamH: number;
  teamA: number;
  /** FPL difficulty rating for the home side, 1 (easiest) to 5. */
  difficultyH: number;
  difficultyA: number;
  finished: boolean;
  kickoff: string | null;
}

/** Everything known before a deadline. Nothing here may come from after it. */
export interface WorldState {
  /** The gameweek being planned for. */
  event: number;
  players: PlayerState[];
  teams: TeamState[];
  /** Upcoming fixtures only. */
  fixtures: FixtureState[];
}

/** One fixture a player faces, from that player's perspective. */
export interface PlayerFixture {
  event: number;
  opponentId: number;
  opponent: string;
  isHome: boolean;
  difficulty: number;
}

/** The expected-points breakdown for one player in one fixture. */
export interface FixtureProjection {
  event: number;
  opponent: string;
  isHome: boolean;
  difficulty: number;
  expectedMinutes: number;
  /** Probability of appearing at all. */
  playProbability: number;
  /** Probability of lasting the hour, which gates clean sheets. */
  sixtyProbability: number;
  /** Probability the player's team keeps a clean sheet. */
  cleanSheetProbability: number;
  points: number;
  components: {
    appearance: number;
    goals: number;
    assists: number;
    cleanSheet: number;
    concede: number;
    saves: number;
    defcon: number;
    bonus: number;
    cards: number;
  };
}

export interface PlayerProjection {
  playerId: number;
  name: string;
  position: PositionShort;
  teamId: number;
  price: number;
  /** Per-fixture detail across the horizon; empty for a blank gameweek. */
  fixtures: FixtureProjection[];
  /** Expected points in the gameweek being planned for. */
  next: number;
  /** Decay-weighted expected points across the horizon. */
  horizon: number;
  /** Undiscounted horizon total, for reporting. */
  horizonRaw: number;
  /** Roughly a 90th-percentile outcome next gameweek, for captaincy. */
  ceiling: number;
  /** Probability of returning 10+ points next gameweek. */
  haulProbability: number;
  /** Availability multiplier that was applied, for explanation. */
  availability: number;
}
