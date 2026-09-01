import type { ChipKey } from '@/lib/fpl/model';
import { bestEleven, horizonEvents, pointsFor, squadValue, type EventPoints } from './squad';
import type { PlayerProjection } from './types';
import type { Weights } from './weights';

/**
 * Chip evaluation.
 *
 * Each chip is priced in expected points, then held to a threshold. The point
 * is to refuse a chip that is merely available: a Bench Boost is worth what the
 * bench is projected to score, and if that is nine points it is not worth
 * burning the chip.
 */

export interface ChipEvaluation {
  chip: ChipKey;
  available: boolean;
  /** Expected points gained by playing it this gameweek. */
  value: number;
  /** The bar this chip has to clear. */
  threshold: number;
  /** Whether the engine thinks it is worth playing now. */
  recommended: boolean;
  reason: string;
}

export interface ChipAnalysis {
  evaluations: ChipEvaluation[];
  /** The chip worth playing, or null when none is. */
  recommended: ChipKey | null;
}

export interface ChipInput {
  squad: PlayerProjection[];
  /** Best possible squad within budget, for wildcard and free hit comparisons. */
  optimalSquad?: PlayerProjection[];
  available: ChipKey[];
  startEvent: number;
  index: EventPoints;
  weights: Weights;
  captainExpected: number;
}

export function evaluateChips(input: ChipInput): ChipAnalysis {
  const { squad, available, startEvent, index, weights, captainExpected } = input;
  const events = horizonEvents(startEvent, weights);
  const eleven = bestEleven(squad, startEvent, index);

  const evaluations: ChipEvaluation[] = [];

  // --- Bench Boost: worth exactly what the bench is projected to score ------
  {
    const benchTotal = eleven.bench.reduce(
      (sum, p) => sum + pointsFor(index, p.playerId, startEvent),
      0,
    );
    const blanks = eleven.bench.filter(
      (p) => pointsFor(index, p.playerId, startEvent) < 1.5,
    ).length;
    evaluations.push({
      chip: 'bboost',
      available: available.includes('bboost'),
      value: round2(benchTotal),
      threshold: weights.benchBoostThreshold,
      recommended:
        available.includes('bboost') && benchTotal >= weights.benchBoostThreshold && blanks === 0,
      reason:
        blanks > 0
          ? `${blanks} bench player${blanks === 1 ? '' : 's'} may not play`
          : `bench projects ${benchTotal.toFixed(1)} points`,
    });
  }

  // --- Triple Captain: one extra copy of the captain's score ---------------
  {
    evaluations.push({
      chip: '3xc',
      available: available.includes('3xc'),
      value: round2(captainExpected),
      threshold: weights.tripleCaptainThreshold,
      recommended:
        available.includes('3xc') && captainExpected >= weights.tripleCaptainThreshold,
      reason: `captain projects ${captainExpected.toFixed(1)} points`,
    });
  }

  // --- Free Hit: this week only, current squad versus the best available ---
  {
    const current = eleven.total;
    const optimal = input.optimalSquad
      ? bestEleven(input.optimalSquad, startEvent, index).total
      : current;
    const gain = optimal - current;
    const nonPlayers = squad.filter(
      (p) => !p.fixtures.some((f) => f.event === startEvent),
    ).length;

    evaluations.push({
      chip: 'freehit',
      available: available.includes('freehit'),
      value: round2(gain),
      threshold: weights.freeHitThreshold,
      recommended: available.includes('freehit') && gain >= weights.freeHitThreshold,
      reason:
        nonPlayers >= 4
          ? `${nonPlayers} of your squad have no fixture this week`
          : `a free-hit squad projects ${gain.toFixed(1)} more this week`,
    });
  }

  // --- Wildcard: the whole horizon, current squad versus the best available -
  {
    const current = squadValue(squad, events, index, weights);
    const optimal = input.optimalSquad
      ? squadValue(input.optimalSquad, events, index, weights)
      : current;
    const gain = optimal - current;

    evaluations.push({
      chip: 'wildcard',
      available: available.includes('wildcard'),
      value: round2(gain),
      threshold: weights.wildcardThreshold,
      recommended: available.includes('wildcard') && gain >= weights.wildcardThreshold,
      reason: `rebuilding projects ${gain.toFixed(1)} more over ${weights.horizon} gameweeks`,
    });
  }

  // At most one chip can be played in a gameweek; take the biggest edge over
  // its own threshold so the chips stay comparable to each other.
  const recommended =
    evaluations
      .filter((e) => e.recommended)
      .sort((a, b) => b.value - b.threshold - (a.value - a.threshold))[0]?.chip ?? null;

  return { evaluations, recommended };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
