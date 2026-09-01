/**
 * Shapes returned by the public FPL API (fantasy.premierleague.com/api).
 * Only the fields this app actually reads are declared.
 */

export type ElementTypeId = 1 | 2 | 3 | 4;
export type PositionShort = 'GKP' | 'DEF' | 'MID' | 'FWD';

export interface FplElement {
  id: number;
  code: number;
  web_name: string;
  first_name: string;
  second_name: string;
  team: number;
  team_code: number;
  element_type: ElementTypeId;
  now_cost: number; // tenths of a million
  status: string; // a=available d=doubtful i=injured s=suspended u=unavailable n=not in squad
  news: string;
  chance_of_playing_next_round: number | null;
  minutes: number;
  starts: number;
  total_points: number;
  event_points: number;
  points_per_game: string;
  form: string;
  ep_next: string | null;
  selected_by_percent: string;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  own_goals: number;
  penalties_saved: number;
  penalties_missed: number;
  yellow_cards: number;
  red_cards: number;
  bonus: number;
  bps: number;
  ict_index: string;
  expected_goals: string;
  expected_assists: string;
  expected_goal_involvements: string;
  expected_goals_conceded: string;
  expected_goals_per_90: number;
  expected_assists_per_90: number;
  expected_goal_involvements_per_90: number;
  expected_goals_conceded_per_90: number;
  defensive_contribution: number;
  defensive_contribution_per_90: number;
  saves: number;
  penalties_order: number | null;
  cost_change_start: number;
  transfers_in_event: number;
  transfers_out_event: number;
}

export interface FplTeam {
  id: number;
  name: string;
  short_name: string;
  strength: number | null;
  strength_overall_home: number;
  strength_overall_away: number;
  strength_attack_home: number;
  strength_attack_away: number;
  strength_defence_home: number;
  strength_defence_away: number;
}

export interface FplEvent {
  id: number;
  name: string;
  deadline_time: string;
  deadline_time_epoch: number;
  finished: boolean;
  is_current: boolean;
  is_next: boolean;
  is_previous: boolean;
  average_entry_score: number;
  highest_score: number | null;
}

export interface FplElementType {
  id: ElementTypeId;
  singular_name_short: PositionShort;
  singular_name: string;
  squad_select: number;
  squad_min_play: number;
  squad_max_play: number;
}

export interface FplChipDefinition {
  id: number;
  name: string; // wildcard | freehit | bboost | 3xc
  number: number;
  start_event: number;
  stop_event: number;
  chip_type: string;
}

export interface FplBootstrap {
  events: FplEvent[];
  teams: FplTeam[];
  elements: FplElement[];
  element_types: FplElementType[];
  chips: FplChipDefinition[];
  total_players: number;
}

export interface FplFixture {
  id: number;
  code: number;
  event: number | null;
  finished: boolean;
  kickoff_time: string | null;
  team_h: number;
  team_a: number;
  team_h_score: number | null;
  team_a_score: number | null;
  team_h_difficulty: number;
  team_a_difficulty: number;
}

export interface FplEntry {
  id: number;
  name: string;
  player_first_name: string;
  player_last_name: string;
  started_event: number;
  current_event: number | null;
  /** Gameweeks the manager has actually entered; empty before their first. */
  entered_events: number[];
  summary_overall_points: number | null;
  summary_overall_rank: number | null;
  summary_event_points: number | null;
  summary_event_rank: number | null;
  last_deadline_bank: number | null;
  last_deadline_value: number | null;
  last_deadline_total_transfers: number | null;
}

export interface FplPick {
  element: number;
  position: number; // 1-15, 1-11 are the starters
  multiplier: number; // 0 bench, 1 starter, 2 captain, 3 triple captain
  is_captain: boolean;
  is_vice_captain: boolean;
  element_type: ElementTypeId;
}

export interface FplEntryHistoryRow {
  event: number;
  points: number;
  total_points: number;
  rank: number | null;
  overall_rank: number | null;
  bank: number;
  value: number;
  event_transfers: number;
  event_transfers_cost: number;
  points_on_bench: number;
}

export interface FplPicksResponse {
  active_chip: string | null;
  automatic_subs: unknown[];
  entry_history: FplEntryHistoryRow;
  picks: FplPick[];
}

export interface FplUsedChip {
  name: string;
  time: string;
  event: number;
}

export interface FplEntryHistory {
  current: FplEntryHistoryRow[];
  past: { season_name: string; total_points: number; rank: number }[];
  chips: FplUsedChip[];
}
