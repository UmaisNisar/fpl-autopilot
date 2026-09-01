import 'server-only';

import {
  FplError,
  getBootstrap,
  getEntry,
  getEntryHistory,
  getFixtures,
  getPicks,
} from './client';
import type { FplBootstrap, FplElement, FplEntryHistory, FplEvent, FplFixture, FplTeam } from './types';
import type { ChipKey, FixtureLite, ManualSquad, SquadPlayer, TeamSnapshot } from './model';
import { HORIZON, project, round1 } from '@/lib/analysis/projection';
import { bestStartingXi } from '@/lib/analysis/lineup';

const CHIP_KEYS: ChipKey[] = ['wildcard', 'freehit', 'bboost', '3xc'];
const MAX_FREE_TRANSFERS = 5;

/** Every manager starts with exactly this budget, in millions. */
const STARTING_BUDGET = 100.0;
const SQUAD_SIZE = 15;

const num = (v: string | number | null | undefined): number => {
  const n = typeof v === 'number' ? v : parseFloat(v ?? '0');
  return Number.isFinite(n) ? n : 0;
};

/** The gameweek we plan for, and the one whose picks we can actually read. */
export function resolveEvents(events: FplEvent[]): { target: FplEvent; source: number } {
  const next = events.find((e) => e.is_next);
  const current = events.find((e) => e.is_current);

  // Plan for the next deadline. Once the final gameweek is live there is no
  // "next", so fall back to the current one.
  const target = next ?? current ?? events[events.length - 1];

  // Picks for the upcoming gameweek only exist once a team has been saved, so
  // read the squad from the most recent gameweek that has already started.
  const source = current?.id ?? (target.id > 1 ? target.id - 1 : target.id);

  return { target, source };
}

/**
 * The FPL API does not expose free transfers without authentication, so we
 * replay the transfer history against the accumulation rules: one per
 * gameweek, banked up to five, and unlimited during a Wildcard or Free Hit.
 */
export function deriveFreeTransfers(
  history: FplEntryHistory,
  startedEvent: number,
  targetEvent: number,
): number {
  const chipByEvent = new Map(history.chips.map((c) => [c.event, c.name]));
  const rows = [...history.current].sort((a, b) => a.event - b.event);

  // You enter your first playable gameweek with exactly one free transfer;
  // the gameweek you joined in has unlimited selection and no FT concept.
  let free = 1;
  for (const row of rows) {
    if (row.event <= startedEvent || row.event >= targetEvent) continue;

    const chip = chipByEvent.get(row.event);
    const unlimited = chip === 'wildcard' || chip === 'freehit';
    const used = unlimited ? 0 : row.event_transfers;

    const remaining = Math.max(0, free - used);
    free = Math.min(MAX_FREE_TRANSFERS, remaining + 1);
  }

  return Math.max(1, Math.min(MAX_FREE_TRANSFERS, free));
}

/**
 * Chips come in two halves of the season (GW1-19, GW20-38). A chip is
 * available when its window covers the target gameweek and no chip of that
 * name has been played inside that window.
 */
export function deriveChips(
  bootstrap: FplBootstrap,
  history: FplEntryHistory,
  targetEvent: number,
): { available: ChipKey[]; used: { name: ChipKey; event: number }[] } {
  const used = history.chips
    .filter((c) => (CHIP_KEYS as string[]).includes(c.name))
    .map((c) => ({ name: c.name as ChipKey, event: c.event }));

  const available = new Set<ChipKey>();
  for (const def of bootstrap.chips) {
    const name = def.name as ChipKey;
    if (!CHIP_KEYS.includes(name)) continue;
    if (targetEvent < def.start_event || targetEvent > def.stop_event) continue;

    const spent = used.some(
      (u) => u.name === name && u.event >= def.start_event && u.event <= def.stop_event,
    );
    if (!spent) available.add(name);
  }

  return { available: CHIP_KEYS.filter((k) => available.has(k)), used };
}

/** Upcoming fixtures per team, keeping doubles and blanks intact. */
export function buildFixtureIndex(
  fixtures: FplFixture[],
  teams: FplTeam[],
  fromEvent: number,
  horizon: number = HORIZON,
): Map<number, FixtureLite[]> {
  const shortName = new Map(teams.map((t) => [t.id, t.short_name]));
  const index = new Map<number, FixtureLite[]>();
  const maxEvent = fromEvent + horizon - 1;

  const push = (teamId: number, fixture: FixtureLite) => {
    const list = index.get(teamId);
    if (list) list.push(fixture);
    else index.set(teamId, [fixture]);
  };

  for (const fx of fixtures) {
    if (fx.event === null || fx.finished) continue;
    if (fx.event < fromEvent || fx.event > maxEvent) continue;

    push(fx.team_h, {
      event: fx.event,
      opponent: shortName.get(fx.team_a) ?? 'TBC',
      isHome: true,
      difficulty: fx.team_h_difficulty,
      kickoff: fx.kickoff_time,
    });
    push(fx.team_a, {
      event: fx.event,
      opponent: shortName.get(fx.team_h) ?? 'TBC',
      isHome: false,
      difficulty: fx.team_a_difficulty,
      kickoff: fx.kickoff_time,
    });
  }

  for (const list of index.values()) {
    list.sort(
      (a, b) => a.event - b.event || (a.kickoff ?? '').localeCompare(b.kickoff ?? ''),
    );
  }
  return index;
}

/** Gameweeks played so far, used as the rotation-risk denominator. */
export function gamesPlayedSoFar(events: FplEvent[]): number {
  return Math.max(1, events.filter((e) => e.finished).length);
}

export interface EnrichContext {
  teams: Map<number, FplTeam>;
  fixtureIndex: Map<number, FixtureLite[]>;
  gamesPlayed: number;
}

const POSITIONS = ['GKP', 'DEF', 'MID', 'FWD'] as const;

/** Turn a raw API element into the shape both the UI and the prompt use. */
export function enrichPlayer(
  el: FplElement,
  ctx: EnrichContext,
  pick?: { slot: number; isCaptain: boolean; isViceCaptain: boolean },
): SquadPlayer {
  const team = ctx.teams.get(el.team);
  const fixtures = ctx.fixtureIndex.get(el.team) ?? [];
  const projection = project({ element: el, fixtures, gamesPlayed: ctx.gamesPlayed });

  return {
    id: el.id,
    name: el.web_name,
    fullName: `${el.first_name} ${el.second_name}`.trim(),
    position: POSITIONS[el.element_type - 1] ?? 'MID',
    teamShort: team?.short_name ?? 'TBC',
    teamName: team?.name ?? 'Unknown',
    teamCode: el.team_code,
    price: el.now_cost / 10,
    slot: pick?.slot ?? 0,
    isStarter: pick ? pick.slot <= 11 : false,
    isCaptain: pick?.isCaptain ?? false,
    isViceCaptain: pick?.isViceCaptain ?? false,
    totalPoints: el.total_points,
    form: num(el.form),
    pointsPerGame: num(el.points_per_game),
    minutes: el.minutes,
    starts: el.starts,
    goals: el.goals_scored,
    assists: el.assists,
    bonus: el.bonus,
    xgi90: round1(el.expected_goal_involvements_per_90),
    xgc90: round1(el.expected_goals_conceded_per_90),
    defcon90: round1(el.defensive_contribution_per_90),
    status: el.status,
    news: el.news,
    chanceOfPlaying: el.chance_of_playing_next_round,
    selectedBy: num(el.selected_by_percent),
    epNext: num(el.ep_next),
    fixtures,
    fdr: projection.fdr,
    projected: projection.total,
    projNext: projection.next,
  };
}

/** Required squad composition, and the club cap FPL enforces. */
export const SQUAD_SHAPE: Record<(typeof POSITIONS)[number], number> = {
  GKP: 2,
  DEF: 5,
  MID: 5,
  FWD: 3,
};
const MAX_PER_CLUB = 3;

/** Returns a human-readable problem, or null when the squad is legal. */
export function checkSquadLegality(squad: SquadPlayer[]): string | null {
  for (const pos of POSITIONS) {
    const have = squad.filter((p) => p.position === pos).length;
    const want = SQUAD_SHAPE[pos];
    if (have !== want) return `A squad needs ${want} ${pos} players, not ${have}.`;
  }

  const clubs = new Map<string, number>();
  for (const p of squad) clubs.set(p.teamShort, (clubs.get(p.teamShort) ?? 0) + 1);
  const overloaded = [...clubs.entries()].find(([, n]) => n > MAX_PER_CLUB);
  if (overloaded) {
    return `You can only have ${MAX_PER_CLUB} players from one club; this squad has ${overloaded[1]} from ${overloaded[0]}.`;
  }

  const value = squad.reduce((sum, p) => sum + p.price, 0);
  if (value > STARTING_BUDGET + 0.001) {
    return `This squad costs ${value.toFixed(1)}m, which is over the ${STARTING_BUDGET.toFixed(1)}m budget.`;
  }

  return null;
}

/** Everything the dashboard needs about the manager's team for this deadline. */
export async function buildTeamSnapshot(
  managerId: number,
  manual?: ManualSquad,
): Promise<TeamSnapshot> {
  const [bootstrap, fixtures, entry, history] = await Promise.all([
    getBootstrap(),
    getFixtures(),
    getEntry(managerId),
    getEntryHistory(managerId),
  ]);

  const { target, source } = resolveEvents(bootstrap.events);

  const teams = new Map(bootstrap.teams.map((t) => [t.id, t]));
  const elements = new Map(bootstrap.elements.map((e) => [e.id, e]));
  const ctx: EnrichContext = {
    teams,
    fixtureIndex: buildFixtureIndex(fixtures, bootstrap.teams, target.id),
    gamesPlayed: gamesPlayedSoFar(bootstrap.events),
  };

  const base = {
    manager: {
      id: entry.id,
      name: `${entry.player_first_name} ${entry.player_last_name}`.trim(),
      teamName: entry.name,
      overallPoints: entry.summary_overall_points ?? 0,
      overallRank: entry.summary_overall_rank,
      gwPoints: entry.summary_event_points ?? 0,
      gwRank: entry.summary_event_rank,
    },
    gameweek: {
      id: target.id,
      name: target.name,
      deadline: target.deadline_time,
      deadlineEpoch: target.deadline_time_epoch,
      sourceEvent: source,
      averageScore: target.average_entry_score || null,
    },
    chips: deriveChips(bootstrap, history, target.id),
    fetchedAt: new Date().toISOString(),
  };

  // --- Manual squad: the manager typed their team in ------------------------
  if (manual) {
    const squad = manual.playerIds
      .map((id) => {
        const el = elements.get(id);
        return el ? enrichPlayer(el, ctx) : null;
      })
      .filter((p): p is SquadPlayer => p !== null);

    if (squad.length !== SQUAD_SIZE) {
      throw new FplError(
        `A squad needs ${SQUAD_SIZE} players; ${squad.length} were recognised.`,
        400,
      );
    }

    const problem = checkSquadLegality(squad);
    if (problem) throw new FplError(problem, 400);

    // A manually entered squad has no saved lineup, so pick the best legal XI
    // rather than trusting the order it arrived in.
    const { startingXi, bench } = bestStartingXi(squad);
    const ordered = [...startingXi, ...bench];
    const captain =
      startingXi.find((p) => p.id === manual.captainId) ??
      [...startingXi].sort((a, b) => b.projNext - a.projNext)[0];
    const vice =
      startingXi.find((p) => p.id === manual.viceCaptainId && p.id !== captain?.id) ??
      [...startingXi].sort((a, b) => b.projNext - a.projNext).find((p) => p.id !== captain?.id);

    ordered.forEach((player, index) => {
      player.slot = index + 1;
      player.isStarter = index < 11;
      player.isCaptain = player.id === captain?.id;
      player.isViceCaptain = player.id === vice?.id;
    });

    const teamValue = squad.reduce((sum, p) => sum + p.price, 0);
    // Prefer the stated bank. Falling back to 100 minus current value assumes
    // nobody has changed price since the squad was picked, which is only true
    // on the day it was built.
    const bank =
      manual.bank !== undefined
        ? manual.bank
        : Math.round((STARTING_BUDGET - teamValue) * 10) / 10;

    return {
      ...base,
      finances: {
        teamValue: Math.round(teamValue * 10) / 10,
        bank,
        // Before the first deadline the whole team can still be changed freely.
        freeTransfers: SQUAD_SIZE,
        freeTransfersInferred: false,
        unlimitedTransfers: true,
      },
      squad: ordered,
      manualSquad: true,
    };
  }

  // --- Normal path: read the squad the API already knows about --------------
  let picksResponse;
  try {
    picksResponse = await getPicks(managerId, source);
  } catch (error) {
    if (error instanceof FplError && error.status === 404) {
      const notStartedYet = entry.started_event > source || entry.entered_events.length === 0;
      throw new FplError(
        notStartedYet
          ? `Your first gameweek is GW${entry.started_event}, which has not kicked off yet, so the public FPL API will not share your squad. Enter it once here and it will load automatically from GW${entry.started_event} onwards.`
          : `No saved squad found for gameweek ${source}.`,
        409,
        'NO_SQUAD',
      );
    }
    throw error;
  }

  const squad = picksResponse.picks
    .map((pick) => {
      const el = elements.get(pick.element);
      if (!el) return null;
      return enrichPlayer(el, ctx, {
        slot: pick.position,
        isCaptain: pick.is_captain,
        isViceCaptain: pick.is_vice_captain,
      });
    })
    .filter((p): p is SquadPlayer => p !== null)
    .sort((a, b) => a.slot - b.slot);

  return {
    ...base,
    finances: {
      teamValue: (picksResponse.entry_history.value ?? entry.last_deadline_value ?? 1000) / 10,
      bank: (picksResponse.entry_history.bank ?? entry.last_deadline_bank ?? 0) / 10,
      freeTransfers: deriveFreeTransfers(history, entry.started_event, target.id),
      freeTransfersInferred: true,
      unlimitedTransfers: false,
    },
    squad,
    manualSquad: false,
  };
}
