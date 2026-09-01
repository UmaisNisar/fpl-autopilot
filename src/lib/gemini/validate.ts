import type { SquadPlayer, TeamSnapshot } from '@/lib/fpl/model';
import type { PositionShort } from '@/lib/fpl/types';
import { bestStartingXi, formationLabel, isLegalXi, orderBench } from '@/lib/analysis/lineup';
import type {
  ChipRecommendation,
  Confidence,
  GameweekPlan,
  TransferMove,
} from './plan';

const CHIPS: ChipRecommendation[] = ['none', 'wildcard', 'freehit', 'bboost', '3xc'];
const CONFIDENCES: Confidence[] = ['low', 'medium', 'high'];
const HIT_COST = 4;

/** A valid FPL squad is always 2 keepers, 5 defenders, 5 midfielders, 3 forwards. */
const SQUAD_SHAPE: Record<PositionShort, number> = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };

export interface ValidationContext {
  snapshot: TeamSnapshot;
  candidates: SquadPlayer[];
  /**
   * What the deterministic engine recommended. Used to report when the model
   * departed from the computed best and what that choice is projected to cost.
   */
  engine?: {
    recommendation: { moves: { outId: number; inId: number }[]; captainId: number | null };
    options: { moves: { outId: number; inId: number }[]; net: number }[];
  };
}

export interface ValidatedPlan {
  plan: GameweekPlan;
  warnings: string[];
  /** The 15 players the manager will own if the plan is followed. */
  finalSquad: SquadPlayer[];
  /**
   * The plan expressed as real player records, so the pitch can render it
   * without repeating name resolution in the browser.
   */
  resolved: ResolvedPlan;
}

export interface ResolvedPlan {
  startingXi: SquadPlayer[];
  bench: SquadPlayer[];
  captainId: number | null;
  viceCaptainId: number | null;
  out: SquadPlayer[];
  in: SquadPlayer[];
}

/**
 * Pull JSON out of a model response. Handles a bare object, markdown fences,
 * and stray prose either side of the object.
 */
export function parsePlanJson(text: string): Record<string, unknown> | null {
  const attempt = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  const direct = attempt(text.trim());
  if (direct) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = attempt(fenced[1].trim());
    if (parsed) return parsed;
  }

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) return attempt(text.slice(first, last + 1));

  return null;
}

/** Strip accents, punctuation and case so "Joao Pedro" matches "João Pedro". */
function normalise(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

/**
 * Resolve a model-supplied name to a real player. Models occasionally return a
 * full name, a surname, or a name with the club appended, so match in
 * decreasing order of strictness rather than failing on the first miss.
 */
export function resolvePlayer(name: unknown, pool: SquadPlayer[]): SquadPlayer | null {
  if (typeof name !== 'string' || !name.trim()) return null;
  const target = normalise(name);
  if (!target) return null;

  const exact = pool.find((p) => normalise(p.name) === target);
  if (exact) return exact;

  const full = pool.find((p) => normalise(p.fullName) === target);
  if (full) return full;

  const starts = pool.filter(
    (p) => normalise(p.fullName).startsWith(target) || target.startsWith(normalise(p.name)),
  );
  if (starts.length === 1) return starts[0];

  const contains = pool.filter(
    (p) => normalise(p.fullName).includes(target) || target.includes(normalise(p.name)),
  );
  if (contains.length === 1) return contains[0];

  // Last resort: surname match, but only when it is unambiguous.
  const surname = target.split(' ').pop() ?? '';
  if (surname.length >= 4) {
    const bySurname = pool.filter((p) => normalise(p.fullName).split(' ').includes(surname));
    if (bySurname.length === 1) return bySurname[0];
  }

  return null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function positionCounts(squad: SquadPlayer[]): Record<PositionShort, number> {
  const counts: Record<PositionShort, number> = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of squad) counts[p.position] += 1;
  return counts;
}

/**
 * Validate and repair a raw model response into something safe to render.
 *
 * Nothing here throws. Anything the model got wrong is corrected against the
 * real squad and reported as a warning, so a bad response degrades into a
 * sensible plan rather than a broken screen.
 */
export function validatePlan(
  raw: Record<string, unknown>,
  ctx: ValidationContext,
): ValidatedPlan {
  const warnings: string[] = [];
  const { snapshot, candidates } = ctx;
  const squad = snapshot.squad;

  // --- Chip -----------------------------------------------------------------
  let chip = asString(raw.chip, 'none').toLowerCase() as ChipRecommendation;
  if (!CHIPS.includes(chip)) {
    warnings.push(`Ignored an unrecognised chip suggestion ("${asString(raw.chip)}").`);
    chip = 'none';
  }
  if (chip !== 'none' && !snapshot.chips.available.includes(chip)) {
    warnings.push(`Ignored a ${chip} recommendation — that chip is not available.`);
    chip = 'none';
  }

  // --- Transfers ------------------------------------------------------------
  const rawDecision = (raw.transfer_decision ?? {}) as Record<string, unknown>;
  const rawMoves = asArray(rawDecision.moves);
  const moves: TransferMove[] = [];
  const outPlayers: SquadPlayer[] = [];
  const inPlayers: SquadPlayer[] = [];

  for (const entry of rawMoves) {
    if (!entry || typeof entry !== 'object') continue;
    const move = entry as Record<string, unknown>;

    const out = resolvePlayer(move.out, squad);
    const incoming = resolvePlayer(move.in, candidates);

    if (!out) {
      warnings.push(`Dropped a transfer: "${asString(move.out)}" is not in your squad.`);
      continue;
    }
    if (!incoming) {
      warnings.push(`Dropped a transfer: "${asString(move.in)}" could not be identified.`);
      continue;
    }
    if (outPlayers.some((p) => p.id === out.id) || inPlayers.some((p) => p.id === incoming.id)) {
      warnings.push('Dropped a duplicated transfer.');
      continue;
    }

    moves.push({ out: out.name, in: incoming.name, reason: asString(move.reason) });
    outPlayers.push(out);
    inPlayers.push(incoming);
  }

  // Apply the moves, then verify the resulting squad is actually legal.
  let finalSquad = [
    ...squad.filter((p) => !outPlayers.some((o) => o.id === p.id)),
    ...inPlayers,
  ];

  if (moves.length > 0) {
    const problems: string[] = [];

    const shape = positionCounts(finalSquad);
    const shapeOk = (Object.keys(SQUAD_SHAPE) as PositionShort[]).every(
      (pos) => shape[pos] === SQUAD_SHAPE[pos],
    );
    if (!shapeOk) problems.push('it would leave an illegal squad shape');

    const spend = inPlayers.reduce((s, p) => s + p.price, 0);
    const raised = outPlayers.reduce((s, p) => s + p.price, 0);
    if (spend > snapshot.finances.bank + raised + 0.001) {
      problems.push('you cannot afford it');
    }

    const clubs = new Map<string, number>();
    for (const p of finalSquad) clubs.set(p.teamShort, (clubs.get(p.teamShort) ?? 0) + 1);
    const overloaded = [...clubs.entries()].find(([, n]) => n > 3);
    if (overloaded) problems.push(`it would give you ${overloaded[1]} ${overloaded[0]} players`);

    if (problems.length > 0) {
      warnings.push(`Rejected the suggested transfer because ${problems.join(' and ')}.`);
      moves.length = 0;
      finalSquad = [...squad];
    }
  }

  // Hit cost is arithmetic, never the model's opinion.
  const transfersAreFree =
    snapshot.finances.unlimitedTransfers || chip === 'wildcard' || chip === 'freehit';
  const paidTransfers = transfersAreFree
    ? 0
    : Math.max(0, moves.length - snapshot.finances.freeTransfers);
  const hitCost = paidTransfers * HIT_COST;

  // Only worth reporting when the model's claim actually misleads.
  if (Boolean(rawDecision.take_hit) !== hitCost > 0 && !snapshot.finances.unlimitedTransfers) {
    warnings.push(
      hitCost > 0
        ? `This plan costs ${hitCost} points — you only have ${snapshot.finances.freeTransfers} free transfer${
            snapshot.finances.freeTransfers === 1 ? '' : 's'
          }.`
        : 'Corrected the hit: this plan is within your free transfers.',
    );
  }

  // --- Starting XI ----------------------------------------------------------
  const optimal = bestStartingXi(finalSquad);

  const proposedXi: SquadPlayer[] = [];
  for (const name of asArray(raw.starting_xi)) {
    const player = resolvePlayer(name, finalSquad);
    if (player && !proposedXi.some((p) => p.id === player.id)) proposedXi.push(player);
  }

  let startingXi: SquadPlayer[];
  if (proposedXi.length === 11 && isLegalXi(proposedXi)) {
    startingXi = proposedXi;
  } else {
    startingXi = optimal.startingXi;
    warnings.push(
      proposedXi.length === 11
        ? 'The suggested XI was not a legal formation, so it was rebuilt from projected points.'
        : 'The suggested XI was incomplete, so it was rebuilt from projected points.',
    );
  }

  const xiIds = new Set(startingXi.map((p) => p.id));
  const benchPool = finalSquad.filter((p) => !xiIds.has(p.id));

  // Honour the model's bench order when it names exactly the four subs.
  const proposedBench: SquadPlayer[] = [];
  for (const name of asArray(raw.bench_order)) {
    const player = resolvePlayer(name, benchPool);
    if (player && !proposedBench.some((p) => p.id === player.id)) proposedBench.push(player);
  }

  const benchKeeperFirst =
    proposedBench.length === benchPool.length &&
    proposedBench.length > 0 &&
    (proposedBench[0].position === 'GKP' || !benchPool.some((p) => p.position === 'GKP'));

  const bench = benchKeeperFirst ? proposedBench : orderBench(benchPool);

  // --- Captaincy ------------------------------------------------------------
  const rankedXi = [...startingXi].sort((a, b) => b.projNext - a.projNext);
  let captain = resolvePlayer(raw.captain, startingXi);
  let vice = resolvePlayer(raw.vice_captain, startingXi);

  if (!captain) {
    captain = rankedXi[0];
    warnings.push('The captain pick was not in the starting XI, so the top projected player was used.');
  }
  if (!vice || vice.id === captain.id) {
    vice = rankedXi.find((p) => p.id !== captain!.id) ?? rankedXi[1] ?? captain;
    warnings.push('The vice-captain pick was invalid, so the next best starter was used.');
  }

  // --- Did the model depart from the computed best? -------------------------
  if (ctx.engine) {
    const key = (list: { outId: number; inId: number }[]) =>
      list
        .map((m) => `${m.outId}>${m.inId}`)
        .sort()
        .join(',');

    const chosenKey = key(
      moves.map((m) => ({
        outId: outPlayers.find((p) => p.name === m.out)?.id ?? -1,
        inId: inPlayers.find((p) => p.name === m.in)?.id ?? -1,
      })),
    );
    const engineKey = key(ctx.engine.recommendation.moves);

    if (chosenKey !== engineKey) {
      const chosen = ctx.engine.options.find((o) => key(o.moves) === chosenKey);
      const best = ctx.engine.options.reduce(
        (max, o) => (o.net > max ? o.net : max),
        Number.NEGATIVE_INFINITY,
      );
      const cost = chosen ? best - chosen.net : null;
      warnings.push(
        cost !== null && cost > 0.05
          ? `The AI chose a different transfer from the model's best, projected to cost about ${cost.toFixed(1)} points over the horizon.`
          : "The AI chose a different transfer from the model's best.",
      );
    }

    if (
      ctx.engine.recommendation.captainId !== null &&
      captain.id !== ctx.engine.recommendation.captainId
    ) {
      warnings.push("The AI captained someone other than the model's top pick.");
    }
  }

  // --- Formation, confidence, summary --------------------------------------
  const formation = formationLabel(startingXi);
  const claimedFormation = asString(raw.formation);
  if (claimedFormation && claimedFormation !== formation) {
    warnings.push(`Formation corrected to ${formation} to match the actual XI.`);
  }

  let confidence = asString(raw.confidence, 'medium').toLowerCase() as Confidence;
  if (!CONFIDENCES.includes(confidence)) confidence = 'medium';

  let summary = asString(raw.summary);
  if (!summary) {
    summary =
      moves.length > 0
        ? `Make the transfer and captain ${captain.name}.`
        : `Hold your transfer and captain ${captain.name}.`;
    warnings.push('The model returned no summary.');
  }
  if (summary.length > 900) summary = `${summary.slice(0, 897)}...`;

  const plan: GameweekPlan = {
    transfer: {
      action: moves.length > 0 ? 'transfer' : 'hold',
      moves,
      takeHit: hitCost > 0,
      hitCost,
    },
    captain: captain.name,
    viceCaptain: vice.name,
    formation,
    startingXi: startingXi.map((p) => p.name),
    benchOrder: bench.map((p) => p.name),
    chip,
    confidence,
    summary,
  };

  return {
    plan,
    warnings,
    finalSquad,
    resolved: {
      startingXi,
      bench,
      captainId: captain.id,
      viceCaptainId: vice.id,
      out: outPlayers,
      in: inPlayers,
    },
  };
}

/**
 * A deterministic plan from the local projections alone, used when Gemini is
 * unreachable or returns something unparseable. The app always has an answer.
 */
export function buildFallbackPlan(snapshot: TeamSnapshot, reason: string): ValidatedPlan {
  const { startingXi, bench, formation } = bestStartingXi(snapshot.squad);
  const ranked = [...startingXi].sort((a, b) => b.projNext - a.projNext);

  return {
    plan: {
      transfer: { action: 'hold', moves: [], takeHit: false, hitCost: 0 },
      captain: ranked[0]?.name ?? '—',
      viceCaptain: ranked[1]?.name ?? '—',
      formation,
      startingXi: startingXi.map((p) => p.name),
      benchOrder: bench.map((p) => p.name),
      chip: 'none',
      confidence: 'low',
      summary: `${reason} This is the local projection model's answer: hold your transfer, start the highest-projected legal XI and captain ${
        ranked[0]?.name ?? 'your best player'
      }. Re-run the analysis for a considered recommendation.`,
    },
    warnings: [reason],
    finalSquad: snapshot.squad,
    resolved: {
      startingXi,
      bench,
      captainId: ranked[0]?.id ?? null,
      viceCaptainId: ranked[1]?.id ?? null,
      out: [],
      in: [],
    },
  };
}

/**
 * The engine's own plan, expressed in the same validated shape.
 *
 * Used when Gemini is unreachable or unusable. The deterministic engine has
 * already made every decision, so the fallback is the real recommendation
 * minus the explanation -- not a degraded guess.
 */
export function buildEnginePlan(
  snapshot: TeamSnapshot,
  engine: {
    recommendation: {
      action: 'hold' | 'transfer';
      moves: { outId: number; outName: string; inId: number; inName: string }[];
      takeHit: boolean;
      hitCost: number;
      captainId: number | null;
      viceCaptainId: number | null;
      chip: ChipRecommendation;
      formation: string;
      startingXi: number[];
      bench: number[];
    };
    projectedNext: number;
  },
  candidates: SquadPlayer[],
  reason: string,
): ValidatedPlan {
  const rec = engine.recommendation;
  const pool = [...snapshot.squad, ...candidates];
  const byId = new Map(pool.map((p) => [p.id, p]));

  const outIds = new Set(rec.moves.map((m) => m.outId));
  const incoming = rec.moves
    .map((m) => byId.get(m.inId))
    .filter((p): p is SquadPlayer => p !== undefined);

  const finalSquad = [...snapshot.squad.filter((p) => !outIds.has(p.id)), ...incoming];

  const resolve = (ids: number[]) =>
    ids.map((id) => byId.get(id)).filter((p): p is SquadPlayer => p !== undefined);

  const startingXi = resolve(rec.startingXi);
  const bench = resolve(rec.bench);
  const captain = rec.captainId !== null ? byId.get(rec.captainId) : undefined;
  const vice = rec.viceCaptainId !== null ? byId.get(rec.viceCaptainId) : undefined;

  // If anything failed to resolve, fall back to the local optimiser instead.
  if (startingXi.length !== 11 || finalSquad.length !== 15 || !captain) {
    return buildFallbackPlan(snapshot, reason);
  }

  return {
    plan: {
      transfer: {
        action: rec.action,
        moves: rec.moves.map((m) => ({
          out: m.outName,
          in: m.inName,
          reason: 'Selected by the projection model.',
        })),
        takeHit: rec.hitCost > 0,
        hitCost: rec.hitCost,
      },
      captain: captain.name,
      viceCaptain: vice?.name ?? startingXi.find((p) => p.id !== captain.id)?.name ?? captain.name,
      formation: rec.formation,
      startingXi: startingXi.map((p) => p.name),
      benchOrder: bench.map((p) => p.name),
      chip: rec.chip,
      confidence: 'medium',
      summary: `${reason} This is the projection model's own plan, which is what the AI is normally asked to review: ${
        rec.action === 'hold'
          ? 'hold your transfer'
          : rec.moves.map((m) => `${m.outName} to ${m.inName}`).join(' and ')
      }, captain ${captain.name}. It projects ${engine.projectedNext} points this gameweek.`,
    },
    warnings: [reason],
    finalSquad,
    resolved: {
      startingXi,
      bench,
      captainId: captain.id,
      viceCaptainId: vice?.id ?? null,
      out: snapshot.squad.filter((p) => outIds.has(p.id)),
      in: incoming,
    },
  };
}
