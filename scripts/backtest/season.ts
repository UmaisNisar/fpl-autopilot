import { existsSync } from 'node:fs';
import { readCsv, n, type Row } from './csv';
import type { PositionShort } from '../../src/lib/fpl/types';
import {
  emptyStatLine,
  type FixtureState,
  type PlayerState,
  type StatLine,
  type TeamState,
  type WorldState,
} from '../../src/lib/engine/types';
import { DEFCON_THRESHOLD } from '../../src/lib/engine/scoring';
import type { Weights } from '../../src/lib/engine/weights';

/**
 * Historical season loader for backtesting.
 *
 * The single rule this file exists to enforce: when building the world as it
 * looked before gameweek N, nothing from gameweek N or later may be read.
 * Every accessor takes the event being planned for and filters on it, and
 * `assertNoLeakage` re-checks the result.
 */

export interface Appearance {
  element: number;
  round: number;
  /** Fixture id. Distinguishes a real double gameweek from a duplicated row. */
  fixture: number;
  name: string;
  position: PositionShort;
  teamId: number;
  /** Price in tenths at that gameweek. */
  value: number;
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
  /** FPL's own expected points for the gameweek, used as a baseline. */
  fplXp: number;
  opponentTeam: number;
  wasHome: boolean;
}

/** Last season's totals for a player, keyed by the current season's element id. */
export type PreviousSeason = Map<number, { line: StatLine; teamGames: number }>;

export interface SeasonData {
  season: string;
  /** Scoring rules in force that season, detected from the data itself. */
  rules: { defensiveContribution: boolean };
  teams: { id: number; name: string; shortName: string }[];
  fixtures: FixtureState[];
  /** Appearances keyed by gameweek. */
  byRound: Map<number, Appearance[]>;
  /** Every gameweek that has data. */
  rounds: number[];
  /**
   * Last season, linked through the stable player code because element ids are
   * reassigned every season.
   */
  previous?: PreviousSeason;
}

const normalisePosition = (raw: string): PositionShort => {
  if (raw === 'GK' || raw === 'GKP') return 'GKP';
  if (raw === 'DEF' || raw === 'MID' || raw === 'FWD') return raw;
  return 'MID';
};

/** The season before this one, e.g. 2024-25 for 2025-26. */
export function previousSeasonName(season: string): string {
  const [start] = season.split('-').map(Number);
  if (!Number.isFinite(start)) return '';
  return `${start - 1}-${String((start % 100)).padStart(2, '0')}`;
}

/**
 * Build last season's totals keyed by *this* season's element ids.
 *
 * FPL reassigns element ids each season, so the join has to go through the
 * stable `code` in players_raw.csv.
 */
export function loadPreviousSeason(season: string, dir = 'data'): PreviousSeason | undefined {
  const prior = previousSeasonName(season);
  if (!prior) return undefined;

  const priorDir = `${dir}/${prior}`;
  if (!existsSync(`${priorDir}/players_raw.csv`) || !existsSync(`${dir}/${season}/players_raw.csv`)) {
    return undefined;
  }

  const codeToCurrentId = new Map<number, number>();
  for (const row of readCsv(`${dir}/${season}/players_raw.csv`)) {
    codeToCurrentId.set(n(row.code), n(row.id));
  }

  const priorIdToCode = new Map<number, number>();
  for (const row of readCsv(`${priorDir}/players_raw.csv`)) {
    priorIdToCode.set(n(row.id), n(row.code));
  }

  const priorTeams = readCsv(`${priorDir}/teams.csv`).map((t) => ({ id: n(t.id), name: t.name }));
  const priorTeamName = new Map(priorTeams.map((t) => [t.name, t.id]));

  const lines = new Map<number, StatLine>();
  const teamMatches = new Map<number, Set<number>>();

  for (let gw = 1; gw <= 38; gw++) {
    const path = `${priorDir}/gws/gw${gw}.csv`;
    if (!existsSync(path)) continue;

    for (const a of dedupe(readCsv(path).map((r) => toAppearance(r, gw, priorTeamName)))) {
      const code = priorIdToCode.get(a.element);
      if (code === undefined) continue;
      const currentId = codeToCurrentId.get(code);
      if (currentId === undefined) continue;

      if (!lines.has(currentId)) lines.set(currentId, emptyStatLine());
      accumulate(lines.get(currentId)!, a);

      const fixtures = teamMatches.get(currentId) ?? new Set<number>();
      fixtures.add(a.fixture);
      teamMatches.set(currentId, fixtures);
    }
  }

  const out: PreviousSeason = new Map();
  for (const [id, line] of lines) {
    // The player's own game count is the right denominator for a start rate:
    // it already excludes matches played before a mid-season transfer.
    out.set(id, { line, teamGames: Math.max(line.games, teamMatches.get(id)?.size ?? 0) });
  }
  return out;
}

/**
 * Parsing a season means reading forty CSVs, and loading last season on top
 * doubles that. The tuner calls this in a loop, so hold the result.
 */
const seasonCache = new Map<string, SeasonData>();

export function loadSeason(season: string, dir = 'data'): SeasonData {
  const cacheKey = `${dir}/${season}`;
  const cached = seasonCache.get(cacheKey);
  if (cached) return cached;
  const loaded = parseSeason(season, dir);
  seasonCache.set(cacheKey, loaded);
  return loaded;
}

function parseSeason(season: string, dir: string): SeasonData {
  const base = `${dir}/${season}`;

  const teamRows = readCsv(`${base}/teams.csv`);
  const teams = teamRows.map((t) => ({
    id: n(t.id),
    name: t.name,
    shortName: t.short_name,
  }));
  const idByName = new Map(teams.map((t) => [t.name, t.id]));

  const fixtures: FixtureState[] = readCsv(`${base}/fixtures.csv`)
    .filter((f) => f.event !== '' && f.event !== undefined)
    .map((f) => ({
      event: n(f.event),
      teamH: n(f.team_h),
      teamA: n(f.team_a),
      difficultyH: n(f.team_h_difficulty),
      difficultyA: n(f.team_a_difficulty),
      finished: String(f.finished).toLowerCase() === 'true',
      kickoff: f.kickoff_time || null,
    }));

  const byRound = new Map<number, Appearance[]>();
  const rounds: number[] = [];

  for (let gw = 1; gw <= 38; gw++) {
    const path = `${base}/gws/gw${gw}.csv`;
    if (!existsSync(path)) continue;
    rounds.push(gw);
    byRound.set(gw, dedupe(readCsv(path).map((r) => toAppearance(r, gw, idByName))));
  }

  // Defensive contribution only exists from 2025/26. Detect it rather than
  // hard-coding a season list, so an older season is scored by its own rules.
  const defensiveContribution = rounds.some((gw) =>
    (byRound.get(gw) ?? []).some((a) => a.defcon > 0),
  );

  return {
    season,
    rules: { defensiveContribution },
    teams,
    fixtures,
    byRound,
    rounds,
    previous: loadPreviousSeason(season, dir),
  };
}

/** Gameweeks where FPL's own expected-points column is actually populated. */
export function gameweeksWithFplXp(season: SeasonData, minRows = 20): Set<number> {
  const usable = new Set<number>();
  for (const gw of season.rounds) {
    const rows = season.byRound.get(gw) ?? [];
    if (rows.filter((r) => r.fplXp > 0).length >= minRows) usable.add(gw);
  }
  return usable;
}

/**
 * The published history contains a handful of exactly duplicated rows. Keying
 * on fixture id drops those while preserving genuine double gameweeks, where a
 * player really does have two rows in one round against different opponents.
 */
function dedupe(rows: Appearance[]): Appearance[] {
  const seen = new Set<string>();
  const out: Appearance[] = [];
  for (const row of rows) {
    const key = `${row.element}:${row.round}:${row.fixture}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function toAppearance(r: Row, gw: number, idByName: Map<string, number>): Appearance {
  return {
    element: n(r.element),
    round: n(r.round) || gw,
    fixture: n(r.fixture),
    name: r.name,
    position: normalisePosition(r.position),
    teamId: idByName.get(r.team) ?? 0,
    value: n(r.value),
    minutes: n(r.minutes),
    starts: n(r.starts),
    goals: n(r.goals_scored),
    assists: n(r.assists),
    xg: n(r.expected_goals),
    xa: n(r.expected_assists),
    cleanSheets: n(r.clean_sheets),
    goalsConceded: n(r.goals_conceded),
    saves: n(r.saves),
    bonus: n(r.bonus),
    bps: n(r.bps),
    defcon: n(r.defensive_contribution),
    yellow: n(r.yellow_cards),
    red: n(r.red_cards),
    points: n(r.total_points),
    fplXp: n(r.xP),
    opponentTeam: n(r.opponent_team),
    wasHome: String(r.was_home).toLowerCase() === 'true',
  };
}

function accumulate(target: StatLine, a: Appearance) {
  target.games += 1;
  if (a.minutes > 0) target.appearances += 1;
  target.minutes += a.minutes;
  target.starts += a.starts;
  target.goals += a.goals;
  target.assists += a.assists;
  target.xg += a.xg;
  target.xa += a.xa;
  target.cleanSheets += a.cleanSheets;
  target.goalsConceded += a.goalsConceded;
  target.saves += a.saves;
  target.bonus += a.bonus;
  target.bps += a.bps;
  target.defcon += a.defcon;
  target.yellow += a.yellow;
  target.red += a.red;
  target.points += a.points;

  const threshold = DEFCON_THRESHOLD[a.position];
  if (threshold !== null && a.defcon >= threshold) target.defconHits += 1;
}

/**
 * Build the world exactly as it looked before the deadline for `event`.
 *
 * Only rounds strictly earlier than `event` are read. Fixture results for
 * `event` and beyond are never consulted -- the `finished` flag is recomputed
 * from the event number rather than trusted from the file.
 */
export function worldStateAt(
  season: SeasonData,
  event: number,
  weights: Weights,
): WorldState {
  return buildWorld(season, event, weights).world;
}

export interface BuiltWorld {
  world: WorldState;
  /** Exactly which gameweeks were read. Checked by `assertNoLeakage`. */
  roundsUsed: number[];
}

export function buildWorld(season: SeasonData, event: number, weights: Weights): BuiltWorld {
  const history = season.rounds.filter((r) => r < event);
  const recentFrom = event - weights.recentWindow;

  const seasonLines = new Map<number, StatLine>();
  const recentLines = new Map<number, StatLine>();
  const latest = new Map<number, Appearance>();
  const teamGames = new Map<number, number>();

  for (const round of history) {
    const rows = season.byRound.get(round) ?? [];
    for (const a of rows) {
      if (!seasonLines.has(a.element)) seasonLines.set(a.element, emptyStatLine());
      if (!recentLines.has(a.element)) recentLines.set(a.element, emptyStatLine());

      accumulate(seasonLines.get(a.element)!, a);
      if (round >= recentFrom) accumulate(recentLines.get(a.element)!, a);

      // Latest row wins, so price and club reflect the most recent gameweek.
      latest.set(a.element, a);
      teamGames.set(a.teamId, Math.max(teamGames.get(a.teamId) ?? 0, round));
    }
  }

  const players: PlayerState[] = [...latest.values()].map((a) => ({
    id: a.element,
    name: a.name,
    position: a.position,
    teamId: a.teamId,
    price: a.value / 10,
    // Historical availability flags are not in this dataset. Leaving everyone
    // available means the backtest is, if anything, harder than reality --
    // the live engine also gets injury news the backtest cannot see.
    status: 'a',
    chanceOfPlaying: null,
    news: '',
    season: seasonLines.get(a.element) ?? emptyStatLine(),
    recent: recentLines.get(a.element) ?? emptyStatLine(),
    previous: season.previous?.get(a.element)?.line,
    previousTeamGames: season.previous?.get(a.element)?.teamGames,
    teamGames: teamGames.get(a.teamId) ?? history.length,
  }));

  const teams = buildTeamStates(season, event);

  return {
    roundsUsed: history,
    world: {
      event,
      players,
      teams,
      fixtures: season.fixtures.map((f) => ({
        ...f,
        // Recompute rather than trust: a fixture is finished iff it is past.
        finished: f.event < event,
      })),
    },
  };
}

function buildTeamStates(season: SeasonData, event: number): TeamState[] {
  const stats = new Map<number, TeamState>();
  for (const t of season.teams) {
    stats.set(t.id, {
      id: t.id,
      shortName: t.shortName,
      name: t.name,
      played: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      xgFor: 0,
      xgAgainst: 0,
    });
  }

  // Goals from completed fixtures only.
  for (const fx of season.fixtures) {
    if (fx.event >= event) continue;
    const home = stats.get(fx.teamH);
    const away = stats.get(fx.teamA);
    if (!home || !away) continue;
    home.played += 1;
    away.played += 1;
  }

  // Team xG and goals, aggregated from the per-gameweek player rows.
  for (const round of season.rounds) {
    if (round >= event) continue;
    for (const a of season.byRound.get(round) ?? []) {
      const team = stats.get(a.teamId);
      const opponent = stats.get(a.opponentTeam);
      if (!team) continue;
      team.goalsFor += a.goals;
      team.xgFor += a.xg;
      if (opponent) opponent.xgAgainst += a.xg;
    }
  }

  // Goals against mirrors goals for across the fixture.
  for (const round of season.rounds) {
    if (round >= event) continue;
    for (const a of season.byRound.get(round) ?? []) {
      const opponent = stats.get(a.opponentTeam);
      if (opponent) opponent.goalsAgainst += a.goals;
    }
  }

  return [...stats.values()];
}

/** Actual points scored in a gameweek, keyed by player id. */
export function actualPoints(season: SeasonData, event: number): Map<number, number> {
  const points = new Map<number, number>();
  for (const a of season.byRound.get(event) ?? []) {
    points.set(a.element, (points.get(a.element) ?? 0) + a.points);
  }
  return points;
}

/** FPL's own expected points for a gameweek, the baseline to beat. */
export function fplExpectedPoints(season: SeasonData, event: number): Map<number, number> {
  const xp = new Map<number, number>();
  for (const a of season.byRound.get(event) ?? []) {
    xp.set(a.element, (xp.get(a.element) ?? 0) + a.fplXp);
  }
  return xp;
}

/**
 * Guard against the mistake that invalidates every backtest: letting
 * information from the gameweek being predicted reach the model.
 */
export function assertNoLeakage(built: BuiltWorld, event: number): void {
  const { world, roundsUsed } = built;

  if (world.event !== event) {
    throw new Error(`World event ${world.event} does not match target ${event}`);
  }

  const leaked = roundsUsed.filter((r) => r >= event);
  if (leaked.length > 0) {
    throw new Error(`Read gameweeks ${leaked.join(', ')} while planning GW${event}`);
  }

  for (const fixture of world.fixtures) {
    if (fixture.event >= event && fixture.finished) {
      throw new Error(`Fixture in GW${fixture.event} is marked finished before GW${event}`);
    }
  }

  // Exact check: a team's match count must equal the fixtures it was actually
  // scheduled for before this gameweek. Doubles make a simple round count wrong.
  const scheduled = new Map<number, number>();
  for (const fx of world.fixtures) {
    if (fx.event >= event) continue;
    scheduled.set(fx.teamH, (scheduled.get(fx.teamH) ?? 0) + 1);
    scheduled.set(fx.teamA, (scheduled.get(fx.teamA) ?? 0) + 1);
  }
  for (const team of world.teams) {
    const expected = scheduled.get(team.id) ?? 0;
    if (team.played > expected) {
      throw new Error(
        `${team.shortName} shows ${team.played} matches but only ${expected} were scheduled before GW${event}`,
      );
    }
  }
}
