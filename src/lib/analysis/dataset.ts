import 'server-only';

import { getBootstrap, getFixtures } from '@/lib/fpl/client';
import { fetchHistories } from '@/lib/fpl/history';
import { buildFixtureIndex, enrichPlayer, gamesPlayedSoFar } from '@/lib/fpl/service';
import type { PositionShort } from '@/lib/fpl/types';
import type { ChipKey, SquadPlayer, TeamSnapshot } from '@/lib/fpl/model';
import { toWorldState } from '@/lib/engine/adapter';
import { projectAll, runEngine, shortlistCandidates, type EngineAnalysis } from '@/lib/engine/plan';
import { DEFAULT_WEIGHTS, ENGINE_VERSION } from '@/lib/engine/weights';
import { TRANSFER_HIT_COST } from '@/lib/engine/scoring';
import type { PlayerProjection } from '@/lib/engine/types';

/**
 * Turn a manager's situation into a decision brief.
 *
 * The deterministic engine does the work: projections, transfer evaluation,
 * lineup optimisation, captaincy and chips. What reaches Gemini is the finished
 * analysis with the numbers attached -- not a pile of raw statistics for it to
 * eyeball.
 */

/** A player reduced to what informs a decision, with the engine's numbers on top. */
export interface CompactPlayer {
  id: number;
  name: string;
  team: string;
  pos: PositionShort;
  price: number;
  /** Expected points next gameweek, from the engine. */
  xp: number;
  /** Decay-weighted expected points across the horizon. */
  xpHorizon: number;
  /** Expected minutes next gameweek. */
  xMins: number;
  /** Probability of a double-digit haul. */
  haul: number;
  /** Season points to date. */
  pts: number;
  form: number;
  /** e.g. "GW3 ARS(H)3 | GW4 liv(A)5" -- uppercase home, lowercase away. */
  fixtures: string;
  owned?: number;
  flag?: string;
}

export interface TransferOptionBrief {
  label: string;
  moves: { out: string; in: string }[];
  /** Expected points gained across the horizon, before any hit. */
  gain: number;
  hitCost: number;
  /** Net of the hit and the value of the transfers spent. */
  net: number;
  /** How this compares with banking the transfer instead. */
  vsRoll: number;
}

export interface AnalysisDataset {
  meta: {
    gameweek: number;
    deadline: string;
    horizonGameweeks: number;
    hitCost: number;
    engineVersion: string;
    generatedAt: string;
  };
  manager: { teamName: string; totalPoints: number; overallRank: number | null };
  budget: {
    bankMillions: number;
    squadValueMillions: number;
    freeTransfers: number;
    unlimitedTransfers: boolean;
  };
  chips: { available: ChipKey[]; used: { name: ChipKey; event: number }[] };

  /** Everything the deterministic engine decided, with its workings. */
  engine: {
    recommendation: {
      action: 'hold' | 'transfer';
      moves: { out: string; in: string }[];
      takeHit: boolean;
      hitCost: number;
      captain: string | null;
      viceCaptain: string | null;
      formation: string;
      chip: ChipKey | 'none';
      projectedNextGameweek: number;
    };
    /** Ranked transfer options, including doing nothing. */
    transferOptions: TransferOptionBrief[];
    /** True when the top options are within the model's own noise. */
    transferIsCloseCall: boolean;
    captainCandidates: {
      name: string;
      expected: number;
      ceiling: number;
      haulProbability: number;
      score: number;
    }[];
    captainIsCloseCall: boolean;
    chipEvaluations: {
      chip: ChipKey;
      value: number;
      threshold: number;
      recommended: boolean;
      reason: string;
    }[];
    lineup: {
      formation: string;
      starters: { name: string; pos: PositionShort; xp: number }[];
      bench: { name: string; pos: PositionShort; xp: number }[];
    };
  };

  squad: { starters: CompactPlayer[]; bench: CompactPlayer[]; currentCaptain: string | null };
  replacements: Partial<Record<PositionShort, CompactPlayer[]>>;
  caveats: string[];
}

export interface AnalysisContext {
  dataset: AnalysisDataset;
  /** Enriched candidates, so the validator can resolve any name Gemini returns. */
  candidates: SquadPlayer[];
  engine: EngineAnalysis;
}

function fixtureString(player: SquadPlayer): string {
  if (player.fixtures.length === 0) return 'BLANK - no fixture';
  return player.fixtures
    .map((f) => {
      const opp = f.isHome ? f.opponent.toUpperCase() : f.opponent.toLowerCase();
      return `GW${f.event} ${opp}(${f.isHome ? 'H' : 'A'})${f.difficulty}`;
    })
    .join(' | ');
}

function availabilityFlag(player: SquadPlayer): string | undefined {
  const parts: string[] = [];
  if (player.status !== 'a') {
    const label =
      { d: 'DOUBTFUL', i: 'INJURED', s: 'SUSPENDED', u: 'UNAVAILABLE', n: 'NOT IN SQUAD' }[
        player.status
      ] ?? player.status.toUpperCase();
    parts.push(label);
  }
  if (player.chanceOfPlaying !== null && player.chanceOfPlaying < 100) {
    parts.push(`${player.chanceOfPlaying}% chance`);
  }
  if (player.news) parts.push(player.news);
  return parts.length > 0 ? parts.join(' - ') : undefined;
}

function toCompact(
  player: SquadPlayer,
  projection: PlayerProjection | undefined,
  includeOwnership = false,
): CompactPlayer {
  const compact: CompactPlayer = {
    id: player.id,
    name: player.name,
    team: player.teamShort,
    pos: player.position,
    price: player.price,
    xp: projection?.next ?? 0,
    xpHorizon: projection?.horizon ?? 0,
    xMins: Math.round(projection?.fixtures[0]?.expectedMinutes ?? 0),
    haul: projection?.haulProbability ?? 0,
    pts: player.totalPoints,
    form: player.form,
    fixtures: fixtureString(player),
  };
  if (includeOwnership) compact.owned = player.selectedBy;
  const flag = availabilityFlag(player);
  if (flag) compact.flag = flag;
  return compact;
}

/**
 * Build the brief.
 *
 * Runs in two passes: the first projects everyone from season totals to work
 * out which players a decision could involve, the second re-projects just those
 * with real per-gameweek history, so the minutes model gets the recent form it
 * leans on without fetching six hundred players.
 */
export async function buildAnalysisContext(snapshot: TeamSnapshot): Promise<AnalysisContext> {
  const weights = DEFAULT_WEIGHTS;
  const event = snapshot.gameweek.id;
  const [bootstrap, fixtures] = await Promise.all([getBootstrap(), getFixtures()]);

  // Pass 1 -- season totals only, enough to narrow the field.
  const coarseWorld = toWorldState({ bootstrap, fixtures, event, weights });
  const { projections: coarse } = projectAll(coarseWorld, weights);
  const squadIds = snapshot.squad.map((p) => p.id);
  const coarseSquad = squadIds
    .map((id) => coarse.get(id))
    .filter((p): p is PlayerProjection => p !== undefined);
  const coarseCandidates = shortlistCandidates(
    coarseWorld,
    coarse,
    coarseSquad,
    snapshot.finances.bank,
    weights,
  );

  // Pass 2 -- real gameweek history for the players that matter.
  const relevant = [...squadIds, ...coarseCandidates.map((c) => c.playerId)];
  const histories = await fetchHistories(relevant);
  const world = toWorldState({ bootstrap, fixtures, event, weights, histories });

  const engine = runEngine({
    world,
    squadIds,
    bank: snapshot.finances.bank,
    freeTransfers: snapshot.finances.freeTransfers,
    chipsAvailable: snapshot.chips.available,
    unlimitedTransfers: snapshot.finances.unlimitedTransfers,
    weights,
  });

  // Enrich candidates into the UI's player shape so the validator can resolve
  // whatever Gemini names, and the pitch can render an incoming player.
  const elements = new Map(bootstrap.elements.map((e) => [e.id, e]));
  const ctx = {
    teams: new Map(bootstrap.teams.map((t) => [t.id, t])),
    fixtureIndex: buildFixtureIndex(fixtures, bootstrap.teams, event),
    gamesPlayed: gamesPlayedSoFar(bootstrap.events),
  };

  const candidates: SquadPlayer[] = engine.candidates
    .map((c) => {
      const el = elements.get(c.playerId);
      return el ? enrichPlayer(el, ctx) : null;
    })
    .filter((p): p is SquadPlayer => p !== null);

  const projectionById = new Map<number, PlayerProjection>();
  for (const p of [...engine.squad, ...engine.candidates]) projectionById.set(p.playerId, p);

  const byPosition: Partial<Record<PositionShort, CompactPlayer[]>> = {};
  for (const candidate of candidates) {
    const list = byPosition[candidate.position] ?? [];
    list.push(toCompact(candidate, projectionById.get(candidate.id), true));
    byPosition[candidate.position] = list;
  }

  const nameOf = (id: number | null) =>
    id === null ? null : (projectionById.get(id)?.name ?? null);

  const rollNet = engine.transfers.roll.net;
  // Rolling is the baseline everything is judged against, so it always belongs
  // in the list even when it ranks below the cut.
  const ranked = engine.transfers.ranked.some((o) => o.moves.length === 0)
    ? engine.transfers.ranked
    : [...engine.transfers.ranked, engine.transfers.roll];

  const transferOptions: TransferOptionBrief[] = ranked.map((option) => ({
    label:
      option.moves.length === 0
        ? 'ROLL (make no transfer)'
        : option.moves.map((m) => `${m.outName} -> ${m.inName}`).join(' + '),
    moves: option.moves.map((m) => ({ out: m.outName, in: m.inName })),
    gain: option.gain,
    hitCost: option.hitCost,
    net: option.net,
    vsRoll: round2(option.net - rollNet),
  }));

  const dataset: AnalysisDataset = {
    meta: {
      gameweek: event,
      deadline: snapshot.gameweek.deadline,
      horizonGameweeks: weights.horizon,
      hitCost: TRANSFER_HIT_COST,
      engineVersion: ENGINE_VERSION,
      generatedAt: new Date().toISOString(),
    },
    manager: {
      teamName: snapshot.manager.teamName,
      totalPoints: snapshot.manager.overallPoints,
      overallRank: snapshot.manager.overallRank,
    },
    budget: {
      bankMillions: snapshot.finances.bank,
      squadValueMillions: snapshot.finances.teamValue,
      freeTransfers: snapshot.finances.freeTransfers,
      unlimitedTransfers: snapshot.finances.unlimitedTransfers,
    },
    chips: snapshot.chips,
    engine: {
      recommendation: {
        action: engine.recommendation.action,
        moves: engine.recommendation.moves.map((m) => ({ out: m.outName, in: m.inName })),
        takeHit: engine.recommendation.takeHit,
        hitCost: engine.recommendation.hitCost,
        captain: nameOf(engine.recommendation.captainId),
        viceCaptain: nameOf(engine.recommendation.viceCaptainId),
        formation: engine.recommendation.formation,
        chip: engine.recommendation.chip,
        projectedNextGameweek: engine.projectedNext,
      },
      transferOptions,
      transferIsCloseCall: engine.transfers.isCloseCall,
      captainCandidates: engine.captaincy.candidates.map((c) => ({
        name: c.name,
        expected: c.expected,
        ceiling: c.ceiling,
        haulProbability: c.haulProbability,
        score: c.score,
      })),
      captainIsCloseCall: engine.captaincy.isCloseCall,
      chipEvaluations: engine.chips.evaluations
        .filter((e) => e.available)
        .map((e) => ({
          chip: e.chip,
          value: e.value,
          threshold: e.threshold,
          recommended: e.recommended,
          reason: e.reason,
        })),
      lineup: {
        formation: engine.lineup.formation,
        starters: engine.lineup.starters.map((p) => ({
          name: p.name,
          pos: p.position,
          xp: p.next,
        })),
        bench: engine.lineup.bench.map((p) => ({ name: p.name, pos: p.position, xp: p.next })),
      },
    },
    squad: {
      starters: snapshot.squad
        .filter((p) => p.isStarter)
        .map((p) => toCompact(p, projectionById.get(p.id))),
      bench: snapshot.squad
        .filter((p) => !p.isStarter)
        .map((p) => toCompact(p, projectionById.get(p.id))),
      currentCaptain: snapshot.squad.find((p) => p.isCaptain)?.name ?? null,
    },
    replacements: byPosition,
    caveats: [
      'Selling prices are approximated with current prices; a player whose value has risen may sell for up to 0.5m less.',
      'Free transfers are derived from transfer history because the public API does not expose them.',
      `Expected points come from engine ${ENGINE_VERSION}, walk-forward backtested on past seasons. They are projections, not certainties.`,
    ],
  };

  return { dataset, candidates, engine };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
