/**
 * Adversarial check on the plan validator.
 *
 * The app's one hard guarantee is that a bad model response can never break the
 * screen. Every case below is something a language model has plausibly done:
 * invented players, illegal formations, unaffordable transfers, wrong types,
 * missing fields, prose wrapped around the JSON. Each must produce a legal,
 * renderable plan.
 *
 * Run with: npm run test:validator
 */

import snapshotFixture from '../test/fixtures/snapshot.json';
import type { SquadPlayer, TeamSnapshot } from '../src/lib/fpl/model';
import { isLegalXi } from '../src/lib/analysis/lineup';
import { parsePlanJson, validatePlan } from '../src/lib/gemini/validate';

const snapshot = snapshotFixture as unknown as TeamSnapshot;

/** A few plausible replacements, priced so most are affordable. */
const candidates: SquadPlayer[] = [
  makeCandidate(9001, 'Saka', 'ARS', 'MID', 10.0),
  makeCandidate(9002, 'Palmer', 'CHE', 'MID', 10.5),
  makeCandidate(9003, 'Gabriel', 'ARS', 'DEF', 6.2),
  makeCandidate(9004, 'Isak', 'NEW', 'FWD', 9.1),
  makeCandidate(9005, 'Raya', 'ARS', 'GKP', 5.6),
  makeCandidate(9006, 'Mega Expensive', 'MCI', 'MID', 99.9),
  // Priced to be affordable when Maguire (5.0) is sold with an empty bank.
  makeCandidate(9007, 'Budget Def', 'BOU', 'DEF', 4.5),
  // Exactly 0.1m out of reach on the same swap.
  makeCandidate(9008, 'Just Too Dear', 'BOU', 'DEF', 5.1),
];

function makeCandidate(
  id: number,
  name: string,
  team: string,
  position: SquadPlayer['position'],
  price: number,
): SquadPlayer {
  return {
    id,
    name,
    fullName: name,
    position,
    teamShort: team,
    teamName: team,
    teamCode: 1,
    price,
    slot: 0,
    isStarter: false,
    isCaptain: false,
    isViceCaptain: false,
    totalPoints: 40,
    form: 5,
    pointsPerGame: 5,
    minutes: 900,
    starts: 10,
    goals: 4,
    assists: 4,
    bonus: 6,
    xgi90: 0.6,
    xgc90: 1.1,
    defcon90: 3,
    status: 'a',
    news: '',
    chanceOfPlaying: null,
    selectedBy: 20,
    epNext: 5,
    fixtures: [{ event: snapshot.gameweek.id, opponent: 'XXX', isHome: true, difficulty: 3, kickoff: null }],
    fdr: 3,
    projected: 25,
    projNext: 5,
  };
}

const squadNames = snapshot.squad.map((p) => p.name);
const goodXi = snapshot.squad.filter((p) => p.isStarter).map((p) => p.name);
const goodBench = snapshot.squad.filter((p) => !p.isStarter).map((p) => p.name);

interface Case {
  name: string;
  raw: unknown;
  /** Extra assertions beyond "it produced a legal plan". */
  expect?: (out: ReturnType<typeof validatePlan>) => string | null;
}

const cases: Case[] = [
  {
    name: 'well-formed hold',
    raw: {
      transfer_decision: { action: 'hold', moves: [], take_hit: false, hit_cost: 0 },
      captain: goodXi[4],
      vice_captain: goodXi[5],
      formation: '3-5-2',
      starting_xi: goodXi,
      bench_order: goodBench,
      chip: 'none',
      confidence: 'high',
      summary: 'Hold.',
    },
    expect: (o) =>
      o.plan.transfer.action === 'hold' ? null : 'expected a hold',
  },
  {
    name: 'valid single transfer',
    raw: {
      transfer_decision: {
        action: 'transfer',
        moves: [{ out: 'Maguire', in: 'Budget Def', reason: 'better fixtures' }],
        take_hit: false,
        hit_cost: 0,
      },
      captain: 'Haaland',
      vice_captain: 'B.Fernandes',
      formation: '3-4-3',
      starting_xi: goodXi,
      bench_order: goodBench,
      chip: 'none',
      confidence: 'high',
      summary: 'Swap.',
    },
    expect: (o) =>
      o.plan.transfer.moves.length === 1 && o.finalSquad.length === 15
        ? null
        : 'transfer should have been accepted',
  },
  {
    name: 'hallucinated outgoing player',
    raw: {
      transfer_decision: {
        action: 'transfer',
        moves: [{ out: 'Cristiano Ronaldo', in: 'Saka', reason: 'x' }],
        take_hit: false,
        hit_cost: 0,
      },
      captain: 'Haaland',
      vice_captain: 'Gvardiol',
      formation: '3-4-3',
      starting_xi: goodXi,
      bench_order: goodBench,
      chip: 'none',
      confidence: 'high',
      summary: 'x',
    },
    expect: (o) => (o.plan.transfer.moves.length === 0 ? null : 'should have dropped the move'),
  },
  {
    name: 'transfer that is 0.1m out of reach',
    raw: {
      transfer_decision: {
        action: 'transfer',
        moves: [{ out: 'Maguire', in: 'Just Too Dear', reason: 'x' }],
        take_hit: false,
        hit_cost: 0,
      },
      captain: 'Haaland',
      vice_captain: 'Gvardiol',
      formation: '3-4-3',
      starting_xi: goodXi,
      bench_order: goodBench,
      chip: 'none',
      confidence: 'high',
      summary: 'x',
    },
    expect: (o) =>
      o.plan.transfer.moves.length === 0 ? null : 'should be rejected on price',
  },
  {
    name: 'unaffordable transfer',
    raw: {
      transfer_decision: {
        action: 'transfer',
        moves: [{ out: 'Maguire', in: 'Mega Expensive', reason: 'x' }],
        take_hit: false,
        hit_cost: 0,
      },
      captain: 'Haaland',
      vice_captain: 'Gvardiol',
      formation: '3-4-3',
      starting_xi: goodXi,
      bench_order: goodBench,
      chip: 'none',
      confidence: 'high',
      summary: 'x',
    },
    expect: (o) =>
      o.plan.transfer.moves.length === 0 ? null : 'unaffordable move should be rejected',
  },
  {
    name: 'position-swapping transfer (illegal squad shape)',
    raw: {
      transfer_decision: {
        action: 'transfer',
        moves: [{ out: 'Maguire', in: 'Isak', reason: 'x' }],
        take_hit: false,
        hit_cost: 0,
      },
      captain: 'Haaland',
      vice_captain: 'Gvardiol',
      formation: '3-4-3',
      starting_xi: goodXi,
      bench_order: goodBench,
      chip: 'none',
      confidence: 'high',
      summary: 'x',
    },
    expect: (o) =>
      o.plan.transfer.moves.length === 0 ? null : 'DEF-for-FWD should be rejected',
  },
  {
    name: 'illegal formation (7 defenders)',
    raw: {
      transfer_decision: { action: 'hold', moves: [], take_hit: false, hit_cost: 0 },
      captain: 'Haaland',
      vice_captain: 'Gvardiol',
      formation: '7-3-1',
      starting_xi: squadNames.slice(0, 11),
      bench_order: squadNames.slice(11),
      chip: 'none',
      confidence: 'high',
      summary: 'x',
    },
  },
  {
    name: 'chip that is not available',
    raw: {
      transfer_decision: { action: 'hold', moves: [], take_hit: false, hit_cost: 0 },
      captain: 'Haaland',
      vice_captain: 'Gvardiol',
      formation: '3-4-3',
      starting_xi: goodXi,
      bench_order: goodBench,
      chip: 'bboost',
      confidence: 'high',
      summary: 'x',
    },
    expect: (o) => (o.plan.chip === 'none' ? null : 'spent chip should be refused'),
  },
  {
    name: 'captain not in the XI',
    raw: {
      transfer_decision: { action: 'hold', moves: [], take_hit: false, hit_cost: 0 },
      captain: 'Kinsky',
      vice_captain: 'Kinsky',
      formation: '3-4-3',
      starting_xi: goodXi,
      bench_order: goodBench,
      chip: 'none',
      confidence: 'high',
      summary: 'x',
    },
    expect: (o) =>
      o.plan.captain !== o.plan.viceCaptain && o.plan.startingXi.includes(o.plan.captain)
        ? null
        : 'captain should have been repaired',
  },
  {
    name: 'wrong types everywhere',
    raw: {
      transfer_decision: 'nope',
      captain: 42,
      vice_captain: null,
      formation: ['3', '4', '3'],
      starting_xi: 'Haaland',
      bench_order: { a: 1 },
      chip: 12,
      confidence: 'extremely high',
      summary: 999,
    },
  },
  { name: 'empty object', raw: {} },
  {
    name: 'nulls',
    raw: {
      transfer_decision: null,
      captain: null,
      vice_captain: null,
      formation: null,
      starting_xi: null,
      bench_order: null,
      chip: null,
      confidence: null,
      summary: null,
    },
  },
  {
    name: 'duplicated players in the XI',
    raw: {
      transfer_decision: { action: 'hold', moves: [], take_hit: false, hit_cost: 0 },
      captain: 'Haaland',
      vice_captain: 'Gvardiol',
      formation: '3-4-3',
      starting_xi: Array(11).fill('Haaland'),
      bench_order: goodBench,
      chip: 'none',
      confidence: 'high',
      summary: 'x',
    },
  },
  {
    name: 'three transfers on two free transfers (hit maths)',
    raw: {
      transfer_decision: {
        action: 'transfer',
        moves: [
          { out: 'Maguire', in: 'Budget Def', reason: 'a' },
          { out: 'Mbeumo', in: 'Saka', reason: 'b' },
          { out: 'Szoboszlai', in: 'Palmer', reason: 'c' },
        ],
        take_hit: false,
        hit_cost: 0,
      },
      captain: 'Haaland',
      vice_captain: 'B.Fernandes',
      formation: '3-4-3',
      starting_xi: goodXi,
      bench_order: goodBench,
      chip: 'none',
      confidence: 'medium',
      summary: 'x',
    },
    expect: (o) => {
      const free = snapshot.finances.freeTransfers;
      const expected = Math.max(0, o.plan.transfer.moves.length - free) * 4;
      return o.plan.transfer.hitCost === expected
        ? null
        : `hit cost ${o.plan.transfer.hitCost} != ${expected}`;
    },
  },
];

// --- JSON extraction cases -------------------------------------------------

const parseCases: { name: string; text: string; shouldParse: boolean }[] = [
  { name: 'bare json', text: '{"chip":"none"}', shouldParse: true },
  { name: 'fenced json', text: '```json\n{"chip":"none"}\n```', shouldParse: true },
  { name: 'prose either side', text: 'Sure! Here you go:\n{"chip":"none"}\nHope that helps.', shouldParse: true },
  { name: 'truncated json', text: '{"chip":"non', shouldParse: false },
  { name: 'not json at all', text: 'I cannot help with that.', shouldParse: false },
  { name: 'an array', text: '[1,2,3]', shouldParse: false },
  { name: 'empty string', text: '', shouldParse: false },
];

// --- Run -------------------------------------------------------------------

let failures = 0;

console.log('\nJSON extraction');
for (const c of parseCases) {
  const parsed = parsePlanJson(c.text);
  const ok = (parsed !== null) === c.shouldParse;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
}

console.log('\nPlan validation');
for (const c of cases) {
  let verdict = 'PASS';
  let detail = '';

  try {
    const out = validatePlan(c.raw as Record<string, unknown>, { snapshot, candidates });

    const xi = out.resolved.startingXi;
    const problems: string[] = [];

    if (!isLegalXi(xi)) problems.push('illegal XI');
    if (out.plan.startingXi.length !== 11) problems.push('XI is not 11 names');
    if (out.plan.benchOrder.length !== 4) problems.push('bench is not 4 names');
    if (new Set(xi.map((p) => p.id)).size !== 11) problems.push('duplicate players in XI');
    if (out.finalSquad.length !== 15) problems.push('final squad is not 15');
    if (!out.plan.startingXi.includes(out.plan.captain)) problems.push('captain not starting');
    if (out.plan.captain === out.plan.viceCaptain) problems.push('captain equals vice');
    if (!out.plan.summary) problems.push('empty summary');
    if (out.plan.chip !== 'none' && !snapshot.chips.available.includes(out.plan.chip)) {
      problems.push('unavailable chip');
    }

    const extra = c.expect?.(out);
    if (extra) problems.push(extra);

    if (problems.length > 0) {
      verdict = 'FAIL';
      detail = problems.join('; ');
    }
  } catch (error) {
    verdict = 'THREW';
    detail = error instanceof Error ? error.message : String(error);
  }

  if (verdict !== 'PASS') failures++;
  console.log(`  ${verdict.padEnd(5)} ${c.name}${detail ? ` -- ${detail}` : ''}`);
}

console.log(
  `\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
