import { TRANSFER_HIT_COST } from './scoring';
import {
  buildEventPoints,
  horizonEvents,
  respectsClubLimit,
  squadValue,
  type EventPoints,
} from './squad';
import type { PlayerProjection } from './types';
import type { Weights } from './weights';

/**
 * Transfer evaluation.
 *
 * Every realistic swap is priced against the one option most FPL advice
 * forgets: doing nothing and banking the transfer. A move is only recommended
 * when it beats that baseline by more than the noise in the projections, and a
 * hit is only recommended when it beats it by more than the four points it
 * costs.
 */

export interface TransferMoveEvaluation {
  outId: number;
  outName: string;
  inId: number;
  inName: string;
  /** Expected points the squad gains across the horizon, before any hit. */
  gain: number;
  /** Cost in points of the hits this plan requires. */
  hitCost: number;
  /** gain - hitCost - the option value of the transfers it spends. */
  net: number;
  /** Money left in the bank afterwards. */
  bankAfter: number;
}

export interface TransferOption {
  /** Number of transfers this option spends. */
  count: number;
  moves: TransferMoveEvaluation[];
  gain: number;
  hitCost: number;
  /** The figure options are ranked on. */
  net: number;
  bankAfter: number;
}

export interface TransferAnalysis {
  /** Doing nothing, including the value of banking the free transfer. */
  roll: TransferOption;
  /** Every option considered, best first, roll included. */
  ranked: TransferOption[];
  /** The engine's pick. */
  best: TransferOption;
  /** How much better the best option is than rolling. */
  edgeOverRoll: number;
  /** True when the top options are close enough that judgement should decide. */
  isCloseCall: boolean;
  freeTransfers: number;
  candidatesConsidered: number;
}

export interface TransferInput {
  squad: PlayerProjection[];
  candidates: PlayerProjection[];
  bank: number;
  freeTransfers: number;
  startEvent: number;
  weights: Weights;
  /** Unlimited free transfers, e.g. before the first deadline or on a wildcard. */
  unlimitedTransfers?: boolean;
  /** How many single moves to keep when searching pairs. Bounds the search. */
  pairBeam?: number;
}

/** Points charged for spending `used` transfers given `free` in hand. */
export function hitCostFor(used: number, free: number, unlimited: boolean): number {
  if (unlimited) return 0;
  return Math.max(0, used - free) * TRANSFER_HIT_COST;
}

/**
 * Option value of the transfers a plan leaves unspent.
 *
 * Rolling is not free: a banked transfer buys flexibility next week. Charging
 * for spending one is what stops the engine burning a transfer on a marginal
 * upgrade.
 */
function bankedValue(freeRemaining: number, weights: Weights): number {
  // Only the first banked transfer is worth much; the cap makes the rest thin.
  return Math.min(freeRemaining, 1) * weights.freeTransferValue;
}

export function evaluateTransfers(input: TransferInput): TransferAnalysis {
  const { squad, candidates, bank, freeTransfers, startEvent, weights } = input;
  const unlimited = input.unlimitedTransfers ?? false;
  const events = horizonEvents(startEvent, weights);

  const index = buildEventPoints([...squad, ...candidates]);
  const baseValue = squadValue(squad, events, index, weights);

  const rollOption: TransferOption = {
    count: 0,
    moves: [],
    gain: 0,
    hitCost: 0,
    net: bankedValue(unlimited ? 0 : Math.min(freeTransfers + 1, 5), weights),
    bankAfter: bank,
  };

  const singles = evaluateSingles({
    squad,
    candidates,
    bank,
    baseValue,
    events,
    index,
    weights,
    freeTransfers,
    unlimited,
  });

  const options: TransferOption[] = [rollOption, ...singles];

  // Pairs are only worth searching when they could be free, or when a single
  // move already looks strong enough that a second might too.
  const beam = input.pairBeam ?? 6;
  if ((unlimited || freeTransfers >= 2 || singles.some((s) => s.net > rollOption.net)) && singles.length > 1) {
    options.push(
      ...evaluatePairs({
        squad,
        candidates,
        bank,
        baseValue,
        events,
        index,
        weights,
        freeTransfers,
        unlimited,
        seeds: singles.slice(0, beam),
      }),
    );
  }

  // A two-transfer plan is the same plan whichever leg is applied first, so
  // the pair search naturally produces each one twice. Key on the unordered
  // move set and keep the best-scoring copy.
  const seen = new Set<string>();
  const ranked = [...options]
    .sort((a, b) => b.net - a.net)
    .filter((option) => {
      const key = option.moves
        .map((m) => `${m.outId}>${m.inId}`)
        .sort()
        .join(',');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const best = ranked[0];
  const runnerUp = ranked[1];

  return {
    roll: rollOption,
    ranked: ranked.slice(0, 8),
    best,
    edgeOverRoll: round2(best.net - rollOption.net),
    // Within a point across a five-week horizon is inside the model's noise.
    isCloseCall: runnerUp !== undefined && Math.abs(best.net - runnerUp.net) < 1.0,
    freeTransfers,
    candidatesConsidered: candidates.length,
  };
}

interface SearchContext {
  squad: PlayerProjection[];
  candidates: PlayerProjection[];
  bank: number;
  baseValue: number;
  events: number[];
  index: EventPoints;
  weights: Weights;
  freeTransfers: number;
  unlimited: boolean;
}

function evaluateSingles(ctx: SearchContext): TransferOption[] {
  const { squad, candidates, bank, baseValue, events, index, weights } = ctx;
  const owned = new Set(squad.map((p) => p.playerId));
  const options: TransferOption[] = [];

  for (const out of squad) {
    for (const incoming of candidates) {
      if (owned.has(incoming.playerId)) continue;
      if (incoming.position !== out.position) continue;

      const bankAfter = round1(bank + out.price - incoming.price);
      if (bankAfter < -0.001) continue;

      const nextSquad = squad.map((p) => (p.playerId === out.playerId ? incoming : p));
      if (!respectsClubLimit(nextSquad)) continue;

      const gain = squadValue(nextSquad, events, index, weights) - baseValue;
      const hitCost = hitCostFor(1, ctx.freeTransfers, ctx.unlimited);
      const remainingFree = ctx.unlimited ? 0 : Math.max(0, ctx.freeTransfers - 1);

      options.push({
        count: 1,
        moves: [
          {
            outId: out.playerId,
            outName: out.name,
            inId: incoming.playerId,
            inName: incoming.name,
            gain: round2(gain),
            hitCost,
            net: round2(gain - hitCost),
            bankAfter,
          },
        ],
        gain: round2(gain),
        hitCost,
        net: round2(gain - hitCost + bankedValue(remainingFree, weights)),
        bankAfter,
      });
    }
  }

  return options.sort((a, b) => b.net - a.net).slice(0, 40);
}

function evaluatePairs(ctx: SearchContext & { seeds: TransferOption[] }): TransferOption[] {
  const { squad, candidates, bank, baseValue, events, index, weights, seeds } = ctx;
  const options: TransferOption[] = [];

  for (const seed of seeds) {
    const first = seed.moves[0];
    const afterFirst = squad.map((p) =>
      p.playerId === first.outId
        ? (candidates.find((c) => c.playerId === first.inId) as PlayerProjection)
        : p,
    );
    const ownedAfter = new Set(afterFirst.map((p) => p.playerId));

    for (const out of afterFirst) {
      if (out.playerId === first.inId) continue;
      for (const incoming of candidates) {
        if (ownedAfter.has(incoming.playerId)) continue;
        if (incoming.position !== out.position) continue;

        const bankAfter = round1(seed.bankAfter + out.price - incoming.price);
        if (bankAfter < -0.001) continue;

        const nextSquad = afterFirst.map((p) => (p.playerId === out.playerId ? incoming : p));
        if (!respectsClubLimit(nextSquad)) continue;

        const gain = squadValue(nextSquad, events, index, weights) - baseValue;
        const hitCost = hitCostFor(2, ctx.freeTransfers, ctx.unlimited);
        const remainingFree = ctx.unlimited ? 0 : Math.max(0, ctx.freeTransfers - 2);

        options.push({
          count: 2,
          moves: [
            { ...first },
            {
              outId: out.playerId,
              outName: out.name,
              inId: incoming.playerId,
              inName: incoming.name,
              gain: round2(gain - first.gain),
              hitCost: 0,
              net: round2(gain - first.gain),
              bankAfter,
            },
          ],
          gain: round2(gain),
          hitCost,
          net: round2(gain - hitCost + bankedValue(remainingFree, weights)),
          bankAfter,
        });
      }
    }
  }

  return options.sort((a, b) => b.net - a.net).slice(0, 12);
}

/**
 * Should the engine actually pull the trigger?
 *
 * A transfer has to clear a threshold above rolling, and a hit has to clear a
 * wider one, because the projections are not precise enough to justify acting
 * on a fraction of a point.
 */
export function shouldTransfer(analysis: TransferAnalysis, weights: Weights): boolean {
  const best = analysis.best;
  if (best.count === 0) return false;

  const margin = best.net - analysis.roll.net;
  const bar = best.hitCost > 0 ? weights.hitThreshold : weights.transferThreshold;
  return margin > bar;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
