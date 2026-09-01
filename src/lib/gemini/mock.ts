import 'server-only';

import type { AnalysisDataset } from '@/lib/analysis/dataset';

/**
 * Development stand-in for Gemini, enabled with GEMINI_MOCK=1.
 *
 * It returns the engine's own recommendation in the model's JSON contract, so
 * the whole pipeline can be exercised without an API key. This is also what a
 * well-behaved model should mostly produce: the engine's plan, adopted.
 */
export function mockPlanResponse(dataset: AnalysisDataset): string {
  const { engine } = dataset;
  const rec = engine.recommendation;

  // Match on the whole move set, not on a single leg: a two-transfer plan is
  // one option with one combined gain, so looking each leg up separately
  // reported the pair's total twice.
  const chosen = engine.transferOptions.find(
    (o) =>
      o.moves.length === rec.moves.length &&
      o.moves.every((x, i) => x.out === rec.moves[i].out && x.in === rec.moves[i].in),
  );

  const moves = rec.moves.map((m, index) => ({
    out: m.out,
    in: m.in,
    reason:
      index === 0 && chosen
        ? `This plan projects ${chosen.gain.toFixed(1)} points more over ${dataset.meta.horizonGameweeks} gameweeks, ${chosen.vsRoll.toFixed(1)} better than rolling.`
        : 'Part of the same plan.',
  }));

  const chipNote =
    rec.chip === 'none'
      ? 'No chip is worth playing this week.'
      : `Playing the ${rec.chip} chip.`;

  return JSON.stringify({
    transfer_decision: {
      action: rec.action,
      moves,
      take_hit: rec.takeHit,
      hit_cost: rec.hitCost,
    },
    captain: rec.captain ?? engine.lineup.starters[0]?.name ?? '',
    vice_captain: rec.viceCaptain ?? engine.lineup.starters[1]?.name ?? '',
    formation: rec.formation,
    starting_xi: engine.lineup.starters.map((p) => p.name),
    bench_order: engine.lineup.bench.map((p) => p.name),
    chip: rec.chip,
    confidence: engine.transferIsCloseCall || engine.captainIsCloseCall ? 'medium' : 'high',
    summary: `[MOCK — no Gemini key configured] ${
      rec.action === 'hold'
        ? 'Nothing in the squad justifies spending the transfer this week.'
        : `The engine rates ${rec.moves.map((m) => `${m.out} to ${m.in}`).join(' and ')} as the best available move.`
    } Captain ${rec.captain ?? 'your best starter'}; the plan projects ${rec.projectedNextGameweek} points. ${chipNote}`,
  });
}

export function isMockEnabled(): boolean {
  return process.env.GEMINI_MOCK === '1';
}
