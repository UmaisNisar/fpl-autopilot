import type { ChipKey } from '@/lib/fpl/model';
import type { PositionShort } from '@/lib/fpl/types';
import { evaluateCaptaincy, type CaptaincyAnalysis } from './captain';
import { evaluateChips, type ChipAnalysis } from './chips';
import { CURRENT_RULES, projectPlayer, type ProjectionContext, type SeasonRules } from './expected';
import { modelMinutes } from './minutes';
import { computeTeamRatings } from './strength';
import {
  bestEleven,
  buildEventPoints,
  horizonEvents,
  pointsFor,
  type BestEleven,
} from './squad';
import { evaluateTransfers, shouldTransfer, type TransferAnalysis } from './transfers';
import type { PlayerFixture, PlayerProjection, WorldState } from './types';
import { DEFAULT_WEIGHTS, ENGINE_VERSION, type Weights } from './weights';

/**
 * The decision pipeline, end to end and entirely deterministic.
 *
 *   world state -> team ratings -> player projections -> transfer evaluation
 *   -> starting XI -> captaincy -> chips -> recommendation
 *
 * Gemini never sees this stage. It receives the finished analysis afterwards to
 * sanity-check, resolve genuinely close calls and explain -- which is only
 * meaningful because the numbers were computed first.
 */

const POSITIONS: PositionShort[] = ['GKP', 'DEF', 'MID', 'FWD'];
const CANDIDATES_PER_POSITION: Record<PositionShort, number> = {
  GKP: 6,
  DEF: 14,
  MID: 16,
  FWD: 10,
};

export interface EngineInput {
  world: WorldState;
  /** The 15 player ids currently owned. */
  squadIds: number[];
  bank: number;
  freeTransfers: number;
  chipsAvailable: ChipKey[];
  unlimitedTransfers?: boolean;
  weights?: Weights;
  rules?: SeasonRules;
  /**
   * Pre-computed projections, overriding the engine's own model.
   *
   * Used by the backtest to run an older projection model through this exact
   * decision pipeline, so a comparison measures the projections rather than the
   * machinery around them.
   */
  projections?: Map<number, PlayerProjection>;
}

export interface EngineRecommendation {
  action: 'hold' | 'transfer';
  moves: { outId: number; outName: string; inId: number; inName: string }[];
  takeHit: boolean;
  hitCost: number;
  captainId: number | null;
  viceCaptainId: number | null;
  chip: ChipKey | 'none';
  formation: string;
  startingXi: number[];
  bench: number[];
}

export interface EngineAnalysis {
  version: string;
  event: number;
  weights: Weights;
  /** Projections for the squad as it stands. */
  squad: PlayerProjection[];
  /** Shortlisted replacements, already filtered to affordable and playable. */
  candidates: PlayerProjection[];
  transfers: TransferAnalysis;
  /** Squad after applying the recommended transfer. */
  resultingSquad: PlayerProjection[];
  lineup: BestEleven;
  captaincy: CaptaincyAnalysis;
  chips: ChipAnalysis;
  recommendation: EngineRecommendation;
  /** Expected points next gameweek if the recommendation is followed. */
  projectedNext: number;
  /** Decay-weighted expected points across the horizon. */
  projectedHorizon: number;
}

/** Fixtures each team faces inside the horizon, keyed by team id. */
export function buildTeamFixtures(
  world: WorldState,
  weights: Weights,
): Map<number, PlayerFixture[]> {
  const shortName = new Map(world.teams.map((t) => [t.id, t.shortName]));
  const events = horizonEvents(world.event, weights);
  const lastEvent = events[events.length - 1];
  const index = new Map<number, PlayerFixture[]>();

  const push = (teamId: number, fixture: PlayerFixture) => {
    const list = index.get(teamId);
    if (list) list.push(fixture);
    else index.set(teamId, [fixture]);
  };

  for (const fx of world.fixtures) {
    if (fx.finished) continue;
    if (fx.event < world.event || fx.event > lastEvent) continue;

    push(fx.teamH, {
      event: fx.event,
      opponentId: fx.teamA,
      opponent: shortName.get(fx.teamA) ?? '???',
      isHome: true,
      difficulty: fx.difficultyH,
    });
    push(fx.teamA, {
      event: fx.event,
      opponentId: fx.teamH,
      opponent: shortName.get(fx.teamH) ?? '???',
      isHome: false,
      difficulty: fx.difficultyA,
    });
  }

  for (const list of index.values()) list.sort((a, b) => a.event - b.event);
  return index;
}

/** Project every player in the world state. Cheap enough to just do all of them. */
export function projectAll(
  world: WorldState,
  weights: Weights = DEFAULT_WEIGHTS,
  rules: SeasonRules = CURRENT_RULES,
): { projections: Map<number, PlayerProjection>; ctx: ProjectionContext } {
  const ratings = computeTeamRatings(world.teams, world.fixtures, weights);
  const ctx: ProjectionContext = {
    ratings,
    weights,
    leagueMeanGoals: weights.leagueMeanGoals,
    rules,
  };

  const teamFixtures = buildTeamFixtures(world, weights);
  const projections = new Map<number, PlayerProjection>();

  for (const player of world.players) {
    const fixtures = teamFixtures.get(player.teamId) ?? [];
    projections.set(player.id, projectPlayer(player, fixtures, ctx));
  }

  return { projections, ctx };
}

/**
 * Shortlist replacements.
 *
 * Filtered to what the manager could legally and sensibly buy: affordable after
 * selling someone in that position, likely to start, and not already owned.
 */
export function shortlistCandidates(
  world: WorldState,
  projections: Map<number, PlayerProjection>,
  squad: PlayerProjection[],
  bank: number,
  weights: Weights,
): PlayerProjection[] {
  const owned = new Set(squad.map((p) => p.playerId));
  const byId = new Map(world.players.map((p) => [p.id, p]));

  const clubCounts = new Map<number, number>();
  for (const p of squad) clubCounts.set(p.teamId, (clubCounts.get(p.teamId) ?? 0) + 1);

  const out: PlayerProjection[] = [];

  for (const pos of POSITIONS) {
    const dearestOwned = squad
      .filter((p) => p.position === pos)
      .reduce((max, p) => Math.max(max, p.price), 0);
    const ceiling = bank + dearestOwned;

    const pool = [...projections.values()]
      .filter((p) => p.position === pos)
      .filter((p) => !owned.has(p.playerId))
      .filter((p) => p.price <= ceiling + 0.001)
      .filter((p) => {
        const state = byId.get(p.playerId);
        if (!state) return false;
        const minutes = modelMinutes(state, weights);
        // A rotation risk is not a serious transfer target.
        return minutes.startProbability >= 0.45 && minutes.availability > 0.5;
      })
      .filter((p) => {
        // Respect the three-per-club limit unless we would sell from that club.
        const count = clubCounts.get(p.teamId) ?? 0;
        if (count < 3) return true;
        return squad.some((s) => s.teamId === p.teamId && s.position === pos);
      })
      .sort((a, b) => b.horizon - a.horizon)
      .slice(0, CANDIDATES_PER_POSITION[pos]);

    out.push(...pool);
  }

  return out;
}

/** Best legal squad within budget, used to price a wildcard or free hit. */
function optimalSquad(
  projections: Map<number, PlayerProjection>,
  budget: number,
): PlayerProjection[] {
  // Greedy by projected points per million, respecting shape and club limits.
  // Good enough to price a chip; not used to pick a team.
  const shape: Record<PositionShort, number> = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
  const picked: PlayerProjection[] = [];
  const counts: Record<PositionShort, number> = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  const clubs = new Map<number, number>();
  let spent = 0;

  const pool = [...projections.values()]
    .filter((p) => p.horizon > 0)
    .sort((a, b) => b.horizon / b.price - a.horizon / a.price);

  for (const player of pool) {
    if (picked.length === 15) break;
    if (counts[player.position] >= shape[player.position]) continue;
    if ((clubs.get(player.teamId) ?? 0) >= 3) continue;

    const slotsLeft = 15 - picked.length - 1;
    // Keep enough back to fill the remaining slots at the 4.0m floor.
    if (spent + player.price + slotsLeft * 4.0 > budget) continue;

    picked.push(player);
    counts[player.position] += 1;
    clubs.set(player.teamId, (clubs.get(player.teamId) ?? 0) + 1);
    spent += player.price;
  }

  return picked.length === 15 ? picked : [];
}

export function runEngine(input: EngineInput): EngineAnalysis {
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const { world, squadIds, bank, freeTransfers } = input;

  const projections =
    input.projections ?? projectAll(world, weights, input.rules ?? CURRENT_RULES).projections;

  const squad = squadIds
    .map((id) => projections.get(id))
    .filter((p): p is PlayerProjection => p !== undefined);

  const candidates = shortlistCandidates(world, projections, squad, bank, weights);

  const transfers = evaluateTransfers({
    squad,
    candidates,
    bank,
    freeTransfers,
    startEvent: world.event,
    weights,
    unlimitedTransfers: input.unlimitedTransfers,
  });

  const take = shouldTransfer(transfers, weights);
  const chosen = take ? transfers.best : transfers.roll;

  // Apply the chosen moves to get the squad we will actually field.
  let resultingSquad = [...squad];
  for (const move of chosen.moves) {
    const incoming = candidates.find((c) => c.playerId === move.inId);
    if (!incoming) continue;
    resultingSquad = resultingSquad.map((p) => (p.playerId === move.outId ? incoming : p));
  }

  const index = buildEventPoints([...projections.values()]);
  const lineup = bestEleven(resultingSquad, world.event, index);
  const captaincy = evaluateCaptaincy(lineup.starters, world.event, weights);

  const budget = bank + squad.reduce((sum, p) => sum + p.price, 0);
  const chips = evaluateChips({
    squad: resultingSquad,
    optimalSquad: optimalSquad(projections, budget),
    available: input.chipsAvailable,
    startEvent: world.event,
    index,
    weights,
    captainExpected: captaincy.captain?.expected ?? 0,
  });

  const events = horizonEvents(world.event, weights);
  const projectedNext =
    lineup.total + (captaincy.captain ? pointsFor(index, captaincy.captain.playerId, world.event) : 0);
  const projectedHorizon = events.reduce((sum, event, i) => {
    const eleven = bestEleven(resultingSquad, event, index);
    return sum + eleven.total * Math.pow(weights.horizonDecay, i);
  }, 0);

  return {
    version: ENGINE_VERSION,
    event: world.event,
    weights,
    squad,
    candidates,
    transfers,
    resultingSquad,
    lineup,
    captaincy,
    chips,
    recommendation: {
      action: chosen.moves.length > 0 ? 'transfer' : 'hold',
      moves: chosen.moves.map((m) => ({
        outId: m.outId,
        outName: m.outName,
        inId: m.inId,
        inName: m.inName,
      })),
      takeHit: chosen.hitCost > 0,
      hitCost: chosen.hitCost,
      captainId: captaincy.captain?.playerId ?? null,
      viceCaptainId: captaincy.viceCaptain?.playerId ?? null,
      chip: chips.recommended ?? 'none',
      formation: lineup.formation,
      startingXi: lineup.starters.map((p) => p.playerId),
      bench: lineup.bench.map((p) => p.playerId),
    },
    projectedNext: Math.round(projectedNext * 100) / 100,
    projectedHorizon: Math.round(projectedHorizon * 100) / 100,
  };
}
