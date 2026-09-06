import { CHIP_LABELS, type SquadPlayer, type TeamSnapshot } from '@/lib/fpl/model';
import type { PlanResult } from '@/lib/gemini/plan';

/**
 * Working out what a manager actually has to change on the FPL site.
 *
 * Kept apart from the component so it can be tested directly: the interesting
 * behaviour is the diff against the current team, not the rendering.
 */

export interface Step {
  id: string;
  /** Where this step is carried out on the FPL site. */
  where: 'transfers' | 'my-team';
  label: string;
  detail?: string;
}

export function buildApplySteps(result: PlanResult, snapshot: TeamSnapshot): Step[] {
  const steps: Step[] = [];
  const { plan, resolved } = result;

  // --- transfers ------------------------------------------------------------
  for (const move of plan.transfer.moves) {
    const out = resolved.out.find((p) => p.name === move.out);
    const incoming = resolved.in.find((p) => p.name === move.in);
    steps.push({
      id: `transfer-${move.out}-${move.in}`,
      where: 'transfers',
      label: `Sell ${move.out} → buy ${move.in}`,
      detail:
        out && incoming
          ? `£${out.price.toFixed(1)}m out, £${incoming.price.toFixed(1)}m in`
          : undefined,
    });
  }

  if (plan.transfer.takeHit) {
    steps.push({
      id: 'hit',
      where: 'transfers',
      label: `Confirm the -${plan.transfer.hitCost} point hit`,
      detail: 'The plan already accounts for it',
    });
  }

  // --- lineup, but only what moves -----------------------------------------
  const planStarters = new Set(resolved.startingXi.map((p) => p.id));
  const wasStarting = new Set(snapshot.squad.filter((p) => p.isStarter).map((p) => p.id));

  // A player leaving in a transfer is not benched, he is gone -- telling
  // someone to bench a player they just sold reads as a mistake.
  const outgoingIds = new Set(resolved.out.map((p) => p.id));
  const toBench = snapshot.squad.filter(
    (p) => wasStarting.has(p.id) && !planStarters.has(p.id) && !outgoingIds.has(p.id),
  );

  // Likewise, a player arriving by transfer is not a substitution; he simply
  // comes in, which the transfer step already covers.
  const incomingIds = new Set(resolved.in.map((p) => p.id));
  const promoted = resolved.startingXi.filter(
    (p) => !wasStarting.has(p.id) && !incomingIds.has(p.id),
  );

  const name = (players: SquadPlayer[]) => players.map((p) => p.name).join(', ');

  if (promoted.length > 0 || toBench.length > 0) {
    steps.push({
      id: 'lineup',
      where: 'my-team',
      label:
        promoted.length > 0 && toBench.length > 0
          ? `Start ${name(promoted)}, bench ${name(toBench)}`
          : promoted.length > 0
            ? `Start ${name(promoted)}`
            : `Bench ${name(toBench)}`,
      detail: `Leaves you in ${plan.formation}`,
    });
  }

  // --- captaincy ------------------------------------------------------------
  const currentCaptain = snapshot.squad.find((p) => p.isCaptain)?.name;
  const currentVice = snapshot.squad.find((p) => p.isViceCaptain)?.name;

  if (plan.captain !== currentCaptain) {
    steps.push({
      id: 'captain',
      where: 'my-team',
      label: `Give the armband to ${plan.captain}`,
      detail: currentCaptain ? `Currently ${currentCaptain}` : undefined,
    });
  }
  if (plan.viceCaptain !== currentVice) {
    steps.push({
      id: 'vice',
      where: 'my-team',
      label: `Make ${plan.viceCaptain} vice-captain`,
      detail: currentVice ? `Currently ${currentVice}` : undefined,
    });
  }

  // --- bench order ----------------------------------------------------------
  const benchOutfield = resolved.bench.filter((p) => p.position !== 'GKP');
  const currentBenchOrder = snapshot.squad
    .filter((p) => !p.isStarter && p.position !== 'GKP')
    .sort((a, b) => a.slot - b.slot)
    .map((p) => p.id);
  const orderChanged =
    benchOutfield.length !== currentBenchOrder.length ||
    benchOutfield.some((p, i) => p.id !== currentBenchOrder[i]);

  if (orderChanged && benchOutfield.length > 0) {
    steps.push({
      id: 'bench-order',
      where: 'my-team',
      label: `Set the bench order: ${benchOutfield.map((p) => p.name).join(' → ')}`,
      detail: 'The order they come on if someone does not play',
    });
  }

  // --- chip -----------------------------------------------------------------
  if (plan.chip !== 'none') {
    steps.push({
      id: 'chip',
      where: 'my-team',
      label: `Play your ${CHIP_LABELS[plan.chip]} chip`,
    });
  }

  return steps;
}
