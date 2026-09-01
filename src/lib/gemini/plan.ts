import type { ChipKey, SquadPlayer } from '@/lib/fpl/model';

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
