import { describe, expect, it } from 'vitest';

import snapshotFixture from '../fixtures/snapshot.json';
import { buildApplySteps } from '@/components/apply-steps';
import type { SquadPlayer, TeamSnapshot } from '@/lib/fpl/model';
import type { PlanResult } from '@/lib/gemini/plan';

/**
 * The checklist a manager actually works through on the FPL site.
 *
 * Its value is that it lists only what *changes*, so the failure mode to guard
 * against is telling someone to do something they should not: benching a player
 * they just sold, or re-doing something that already matches.
 */

const snapshot = snapshotFixture as unknown as TeamSnapshot;

const byName = (name: string) => snapshot.squad.find((p) => p.name === name)!;

function result(over: Partial<PlanResult> = {}): PlanResult {
  const starters = snapshot.squad.filter((p) => p.isStarter);
  const bench = snapshot.squad.filter((p) => !p.isStarter);
  const captain = snapshot.squad.find((p) => p.isCaptain) ?? starters[0];
  const vice = snapshot.squad.find((p) => p.isViceCaptain) ?? starters[1];

  return {
    plan: {
      transfer: { action: 'hold', moves: [], takeHit: false, hitCost: 0 },
      captain: captain.name,
      viceCaptain: vice.name,
      formation: '3-4-3',
      startingXi: starters.map((p) => p.name),
      benchOrder: bench.map((p) => p.name),
      chip: 'none',
      confidence: 'high',
      summary: 'Hold.',
    },
    resolved: {
      startingXi: starters,
      bench,
      captainId: captain.id,
      viceCaptainId: vice.id,
      out: [],
      in: [],
    },
    finalSquad: snapshot.squad,
    engine: {
      version: 'test',
      projectedPoints: 50,
      transferOptions: [],
      transferIsCloseCall: false,
      captainCandidates: [],
      captainIsCloseCall: false,
      chipEvaluations: [],
      playerMetrics: {},
    },
    warnings: [],
    fallback: false,
    meta: { gameweek: snapshot.gameweek.id, model: 'test', generatedAt: '' },
    ...over,
  } as PlanResult;
}

const incoming = (name: string, position: SquadPlayer['position']): SquadPlayer => ({
  ...byName(snapshot.squad.find((p) => p.position === position)!.name),
  id: 99999,
  name,
  fullName: name,
});

describe('nothing to do', () => {
  it('produces no steps when the plan matches the team already', () => {
    expect(buildApplySteps(result(), snapshot)).toHaveLength(0);
  });
});

describe('transfers', () => {
  it('lists each move, and never asks you to bench the player you sold', () => {
    // Regression: an outgoing player is not in the new eleven, so a naive diff
    // reported "bench Kayode" one line after "sell Kayode".
    const out = snapshot.squad.find((p) => p.isStarter && p.position === 'DEF')!;
    const arriving = incoming('New Defender', 'DEF');
    const startingXi = [...snapshot.squad.filter((p) => p.isStarter && p.id !== out.id), arriving];

    const steps = buildApplySteps(
      result({
        plan: {
          ...result().plan,
          transfer: {
            action: 'transfer',
            moves: [{ out: out.name, in: arriving.name, reason: '' }],
            takeHit: false,
            hitCost: 0,
          },
        },
        resolved: { ...result().resolved, startingXi, out: [out], in: [arriving] },
      }),
      snapshot,
    );

    expect(steps[0].label).toBe(`Sell ${out.name} → buy ${arriving.name}`);
    expect(steps.map((s) => s.label).join(' ')).not.toMatch(new RegExp(`Bench.*${out.name}`));
  });

  it('calls out a points hit as its own step', () => {
    const steps = buildApplySteps(
      result({
        plan: {
          ...result().plan,
          transfer: { action: 'transfer', moves: [], takeHit: true, hitCost: 4 },
        },
      }),
      snapshot,
    );
    expect(steps.some((s) => s.label.includes('-4 point hit'))).toBe(true);
  });
});

describe('lineup', () => {
  it('names only the players whose starting status changes', () => {
    const starters = snapshot.squad.filter((p) => p.isStarter);
    const bench = snapshot.squad.filter((p) => !p.isStarter);
    // Swap one outfield starter for a bench player of the same position.
    const drop = starters.find((p) => p.position === 'MID')!;
    const promote = bench.find((p) => p.position === 'MID') ?? bench.find((p) => p.position !== 'GKP')!;

    const startingXi = [...starters.filter((p) => p.id !== drop.id), promote];
    const steps = buildApplySteps(
      result({
        resolved: {
          ...result().resolved,
          startingXi,
          bench: [...bench.filter((p) => p.id !== promote.id), drop],
        },
      }),
      snapshot,
    );

    const lineup = steps.find((s) => s.id === 'lineup');
    expect(lineup?.label).toContain(promote.name);
    expect(lineup?.label).toContain(drop.name);
    // Nobody else should be mentioned.
    for (const other of starters.filter((p) => p.id !== drop.id)) {
      expect(lineup?.label).not.toContain(other.name);
    }
  });
});

describe('captaincy', () => {
  it('says nothing when the armband does not move', () => {
    const steps = buildApplySteps(result(), snapshot);
    expect(steps.some((s) => s.id === 'captain')).toBe(false);
  });

  it('names the change and what it replaces', () => {
    const current = snapshot.squad.find((p) => p.isCaptain)!;
    const other = snapshot.squad.find((p) => p.isStarter && p.id !== current.id)!;
    const steps = buildApplySteps(
      result({ plan: { ...result().plan, captain: other.name } }),
      snapshot,
    );
    const step = steps.find((s) => s.id === 'captain');
    expect(step?.label).toContain(other.name);
    expect(step?.detail).toContain(current.name);
  });
});

describe('chips', () => {
  it('adds a step only when a chip is actually being played', () => {
    expect(buildApplySteps(result(), snapshot).some((s) => s.id === 'chip')).toBe(false);

    const steps = buildApplySteps(
      result({ plan: { ...result().plan, chip: 'bboost' } }),
      snapshot,
    );
    expect(steps.find((s) => s.id === 'chip')?.label).toContain('Bench Boost');
  });
});

describe('routing', () => {
  it('sends every step to the right FPL screen', () => {
    const out = snapshot.squad.find((p) => p.isStarter && p.position === 'DEF')!;
    const arriving = incoming('New Defender', 'DEF');
    const steps = buildApplySteps(
      result({
        plan: {
          ...result().plan,
          chip: 'bboost',
          transfer: {
            action: 'transfer',
            moves: [{ out: out.name, in: arriving.name, reason: '' }],
            takeHit: false,
            hitCost: 0,
          },
        },
        resolved: {
          ...result().resolved,
          startingXi: [...snapshot.squad.filter((p) => p.isStarter && p.id !== out.id), arriving],
          out: [out],
          in: [arriving],
        },
      }),
      snapshot,
    );

    expect(steps.find((s) => s.id.startsWith('transfer-'))?.where).toBe('transfers');
    expect(steps.find((s) => s.id === 'chip')?.where).toBe('my-team');
  });
});
