import 'server-only';

import type { FplBootstrap, FplElement, FplFixture, PositionShort } from '@/lib/fpl/types';
import type { HistoryRow, PastSeason, PlayerHistory } from '@/lib/fpl/history';
import { DEFCON_THRESHOLDS } from '@/lib/fpl/history';
import {
  emptyStatLine,
  type FixtureState,
  type PlayerState,
  type StatLine,
  type TeamState,
  type WorldState,
} from './types';
import type { Weights } from './weights';

/**
 * Live FPL API to engine world state.
 *
 * The backtester maps historical CSVs into these same shapes, so the engine
 * cannot tell the two apart -- which is what makes the backtest a test of the
 * thing that actually runs.
 */

const POSITIONS: PositionShort[] = ['GKP', 'DEF', 'MID', 'FWD'];

const num = (v: string | number | null | undefined): number => {
  const parsed = typeof v === 'number' ? v : parseFloat(v ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Season totals straight off `bootstrap-static`. */
function seasonStatLine(el: FplElement, teamGames: number): StatLine {
  const line = emptyStatLine();
  line.games = teamGames;
  line.minutes = el.minutes;
  line.starts = el.starts;
  // Appearances are not published directly; starts plus a share of the rest is
  // the closest honest estimate when no per-gameweek history is available.
  line.appearances = Math.min(teamGames, el.starts + (el.minutes > 0 && el.starts === 0 ? 1 : 0));
  line.goals = el.goals_scored;
  line.assists = el.assists;
  line.xg = num(el.expected_goals);
  line.xa = num(el.expected_assists);
  line.cleanSheets = el.clean_sheets;
  line.goalsConceded = el.goals_conceded;
  line.saves = el.saves;
  line.bonus = el.bonus;
  line.bps = el.bps;
  line.defcon = el.defensive_contribution;
  line.yellow = el.yellow_cards;
  line.red = el.red_cards;
  line.points = el.total_points;
  return line;
}

/** Last season, in the engine's stat-line shape. */
function fromPastSeason(past: PastSeason): StatLine {
  const line = emptyStatLine();
  line.games = past.starts;
  line.minutes = past.minutes;
  line.starts = past.starts;
  // Appearances are not published per season; starts is the honest floor.
  line.appearances = past.starts;
  line.goals = past.goals;
  line.assists = past.assists;
  line.xg = past.xg;
  line.xa = past.xa;
  line.cleanSheets = past.cleanSheets;
  line.goalsConceded = past.goalsConceded;
  line.saves = past.saves;
  line.bonus = past.bonus;
  line.bps = past.bps;
  line.defcon = past.defcon;
  line.yellow = past.yellow;
  line.red = past.red;
  line.points = past.points;
  return line;
}

/** Accumulate per-gameweek rows into a stat line. */
function fromHistory(rows: HistoryRow[], position: PositionShort): StatLine {
  const line = emptyStatLine();
  const threshold = DEFCON_THRESHOLDS[position];

  for (const row of rows) {
    line.games += 1;
    if (row.minutes > 0) line.appearances += 1;
    line.minutes += row.minutes;
    line.starts += row.starts;
    line.goals += row.goals;
    line.assists += row.assists;
    line.xg += row.xg;
    line.xa += row.xa;
    line.cleanSheets += row.cleanSheets;
    line.goalsConceded += row.goalsConceded;
    line.saves += row.saves;
    line.bonus += row.bonus;
    line.bps += row.bps;
    line.defcon += row.defcon;
    line.yellow += row.yellow;
    line.red += row.red;
    line.points += row.points;
    if (threshold !== null && row.defcon >= threshold) line.defconHits += 1;
  }

  return line;
}

export interface AdapterInput {
  bootstrap: FplBootstrap;
  fixtures: FplFixture[];
  /** The gameweek being planned for. */
  event: number;
  weights: Weights;
  /** Per-player gameweek history, where it was fetched. */
  histories?: Map<number, PlayerHistory>;
}

export function toWorldState(input: AdapterInput): WorldState {
  const { bootstrap, fixtures, event, weights, histories } = input;

  const finished = fixtures.filter((f) => f.event !== null && f.event < event && f.finished);

  // Matches played and goals, from results already on the board.
  const teamStats = new Map<number, TeamState>();
  for (const team of bootstrap.teams) {
    teamStats.set(team.id, {
      id: team.id,
      shortName: team.short_name,
      name: team.name,
      played: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      xgFor: 0,
      xgAgainst: 0,
    });
  }

  for (const fx of finished) {
    const home = teamStats.get(fx.team_h);
    const away = teamStats.get(fx.team_a);
    if (!home || !away) continue;
    home.played += 1;
    away.played += 1;
    home.goalsFor += fx.team_h_score ?? 0;
    home.goalsAgainst += fx.team_a_score ?? 0;
    away.goalsFor += fx.team_a_score ?? 0;
    away.goalsAgainst += fx.team_h_score ?? 0;
  }

  // Team expected goals, summed from the squad's individual figures.
  for (const el of bootstrap.elements) {
    const team = teamStats.get(el.team);
    if (!team) continue;
    team.xgFor += num(el.expected_goals);
  }
  // Expected goals conceded is published per player; take the squad maximum as
  // the team figure, since every player's number covers the same matches.
  const xgAgainst = new Map<number, number>();
  for (const el of bootstrap.elements) {
    if (el.minutes <= 0) continue;
    const per90 = el.expected_goals_conceded_per_90;
    if (!Number.isFinite(per90) || per90 <= 0) continue;
    const team = teamStats.get(el.team);
    if (!team || team.played === 0) continue;
    xgAgainst.set(el.team, Math.max(xgAgainst.get(el.team) ?? 0, per90 * team.played));
  }
  for (const [teamId, value] of xgAgainst) {
    const team = teamStats.get(teamId);
    if (team) team.xgAgainst = value;
  }

  const recentFrom = event - weights.recentWindow;

  const players: PlayerState[] = bootstrap.elements.map((el) => {
    const position = POSITIONS[el.element_type - 1] ?? 'MID';
    const teamGames = teamStats.get(el.team)?.played ?? 0;
    const history = histories?.get(el.id);
    const rows = history?.rows;

    const season = rows ? fromHistory(rows, position) : seasonStatLine(el, teamGames);
    const recent = rows
      ? fromHistory(
          rows.filter((r) => r.round >= recentFrom && r.round < event),
          position,
        )
      : emptyStatLine();

    const past = history?.previous;
    const previous = past && past.minutes > 0 ? fromPastSeason(past) : undefined;

    // Season totals from bootstrap have no per-appearance breakdown, so the
    // defensive-contribution hit count has to be inferred by the model instead.
    if (!rows) season.defconHits = 0;

    return {
      id: el.id,
      name: el.web_name,
      position,
      teamId: el.team,
      price: el.now_cost / 10,
      status: el.status,
      chanceOfPlaying: el.chance_of_playing_next_round,
      news: el.news,
      season,
      recent,
      previous,
      // A full Premier League season is 38 matches; that is the denominator a
      // start rate from last season needs.
      previousTeamGames: previous ? 38 : undefined,
      teamGames: Math.max(teamGames, season.games),
    };
  });

  const upcoming: FixtureState[] = fixtures
    .filter((f) => f.event !== null)
    .map((f) => ({
      event: f.event as number,
      teamH: f.team_h,
      teamA: f.team_a,
      difficultyH: f.team_h_difficulty,
      difficultyA: f.team_a_difficulty,
      finished: (f.event as number) < event,
      kickoff: f.kickoff_time,
    }));

  return {
    event,
    players,
    teams: [...teamStats.values()],
    fixtures: upcoming,
  };
}
