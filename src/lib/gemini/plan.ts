import type { ChipKey, SquadPlayer } from '@/lib/fpl/model';

/** Per-player numbers the engine produced, keyed by player id. */
export interface PlayerMetrics {
  /** Expected points next gameweek. */
  xp: number;
  /** Decay-weighted expected points across the horizon. */
  xpHorizon: number;
  /** Expected minutes next gameweek. */
  xMins: number;
  /** Probability of a double-digit haul. */
  haul: number;
}

/**
 * The engine's reasoning, sent to the client so the UI can show why a plan was
 * chosen rather than asking the manager to take it on trust.
 */
export interface EngineBrief {
  version: string;
  /** Expected points for the recommended plan, captain included. */
  projectedPoints: number;
  transferOptions: {
    label: string;
    moves: { out: string; in: string }[];
    gain: number;
    hitCost: number;
    net: number;
    /** Positive means better than banking the transfer. */
    vsRoll: number;
  }[];
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
  playerMetrics: Record<number, PlayerMetrics>;
}

export type ChipRecommendation = ChipKey | 'none';
export type Confidence = 'low' | 'medium' | 'high';

export interface TransferMove {
  /** Player leaving the squad. */
  out: string;
  /** Player coming in. */
  in: string;
  reason: string;
}

export interface TransferDecision {
  action: 'hold' | 'transfer';
  moves: TransferMove[];
  takeHit: boolean;
  /** Points sacrificed, e.g. 4 for a single hit. Zero when no hit is taken. */
  hitCost: number;
}

/** A validated, renderable plan. Every name here resolves to a real player. */
export interface GameweekPlan {
  transfer: TransferDecision;
  captain: string;
  viceCaptain: string;
  formation: string;
  startingXi: string[];
  benchOrder: string[];
  chip: ChipRecommendation;
  confidence: Confidence;
  summary: string;
}

export interface PlanResult {
  plan: GameweekPlan;
  /** The plan as real player records, ready to render. */
  resolved: {
    startingXi: SquadPlayer[];
    bench: SquadPlayer[];
    captainId: number | null;
    viceCaptainId: number | null;
    out: SquadPlayer[];
    in: SquadPlayer[];
  };
  /** The 15 players owned if the plan is followed. */
  finalSquad: SquadPlayer[];
  /** What the deterministic engine computed, for the UI to show its working. */
  engine: EngineBrief;
  /** Corrections applied to the model's raw output, surfaced in the UI. */
  warnings: string[];
  /** True when the model failed and we fell back to the local optimiser. */
  fallback: boolean;
  meta: {
    gameweek: number;
    model: string;
    generatedAt: string;
  };
}
