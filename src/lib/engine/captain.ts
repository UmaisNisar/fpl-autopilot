import type { PlayerProjection } from './types';
import type { Weights } from './weights';

/**
 * Captaincy, evaluated separately from selection.
 *
 * The armband doubles a score, so it belongs on the player with the best
 * combination of expectation and upside -- not simply the highest projection. A
 * defender projected at 5.5 through clean-sheet probability is a worse captain
 * than a striker projected at 5.2 who has a real chance of two goals.
 */

export interface CaptainCandidate {
  playerId: number;
  name: string;
  position: string;
  /** Expected points next gameweek. */
  expected: number;
  /** Roughly a 90th-percentile outcome. */
  ceiling: number;
  /** Probability of a double-digit return. */
  haulProbability: number;
  /** The ranking figure: expectation tilted toward upside. */
  score: number;
  /** Number of fixtures next gameweek -- two in a double. */
  fixtures: number;
}

export interface CaptaincyAnalysis {
  candidates: CaptainCandidate[];
  captain: CaptainCandidate | null;
  viceCaptain: CaptainCandidate | null;
  /** Gap between the top two, in captaincy score. */
  margin: number;
  /** True when the top two are close enough that either is defensible. */
  isCloseCall: boolean;
}

export function evaluateCaptaincy(
  starters: PlayerProjection[],
  event: number,
  weights: Weights,
): CaptaincyAnalysis {
  const candidates: CaptainCandidate[] = starters
    .map((p) => {
      const fixtures = p.fixtures.filter((f) => f.event === event);
      const expected = fixtures.reduce((sum, f) => sum + f.points, 0);
      // Upside is the distance between the ceiling and the mean, so a player
      // whose points come from certainties is not rewarded for them twice.
      const upside = Math.max(0, p.ceiling - p.next);
      return {
        playerId: p.playerId,
        name: p.name,
        position: p.position,
        expected: round2(expected),
        ceiling: p.ceiling,
        haulProbability: p.haulProbability,
        score: round2(expected + weights.captainUpsideWeight * upside),
        fixtures: fixtures.length,
      };
    })
    .filter((c) => c.fixtures > 0)
    .sort((a, b) => b.score - a.score);

  const captain = candidates[0] ?? null;
  const viceCaptain = candidates[1] ?? null;
  const margin = captain && viceCaptain ? round2(captain.score - viceCaptain.score) : 0;

  return {
    candidates: candidates.slice(0, 6),
    captain,
    viceCaptain,
    margin,
    isCloseCall: margin < 0.75,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
