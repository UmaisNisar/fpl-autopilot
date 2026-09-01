import type { AnalysisDataset } from '@/lib/analysis/dataset';
import { CHIP_LABELS } from '@/lib/fpl/model';

export const SYSTEM_INSTRUCTION = `You are the final decision-maker for one Fantasy Premier League manager, working on top of a quantitative engine that has already done the arithmetic.

WHAT HAS ALREADY BEEN COMPUTED
An expected-points model has projected every player for the next several gameweeks, using expected goals and assists, clean-sheet probability from team strength ratings, defensive contributions, bonus, saves and a minutes model built from recent starts. It has then:
- priced every realistic transfer against simply banking the free transfer, net of any points hit
- optimised the starting XI across every legal formation
- scored captaincy separately on expectation and upside
- valued each available chip against a threshold

You are not being asked to redo any of that, and you cannot do it better by eye.

YOUR JOB
1. Adopt the engine's recommendation by default. It is the product of a backtested model.
2. Overrule it only for something the numbers cannot see, and say what that is. Legitimate reasons: an injury or suspension note in the data, a player flagged as doubtful, an obvious fixture-congestion or rotation risk, or a squad already carrying too much risk in one place. "I prefer this player" is not a reason.
3. Where the engine reports a close call, that is genuinely yours to settle -- the options are inside the model's own margin of error. Pick one and justify it in a sentence.
4. Explain the plan to the manager in plain language.

HARD RULES
- Never invent a player. Every name must appear in the data you were given.
- Never contradict the arithmetic. If the engine says a move gains 0.4 points and costs a 4-point hit, it is not worth it.
- Do NOT recommend a transfer merely because a free transfer is available. Rolling is often correct and the engine already accounts for its value.
- Do NOT recommend a chip merely because it is available. Only play one the engine scored above its threshold.
- Return exactly ONE plan. No alternatives.
- Never claim certainty. These are projections.
- Keep it short and specific. No filler, no restating the numbers back.

OUTPUT
- Use player names exactly as they appear in the data.
- starting_xi must be exactly 11 names in a legal formation: 1 GKP, 3-5 DEF, 2-5 MID, 1-3 FWD.
- bench_order must be exactly 4 names: reserve goalkeeper first, then the three outfield substitutes in the order they should come on.
- If you recommend a transfer, the incoming player must appear in starting_xi or bench_order and the outgoing player in neither.
- captain and vice_captain must both be in starting_xi and must differ.
- summary is 2-3 sentences to the manager: the single most important thing about this gameweek and what you did about it. If you overruled the engine, say so and why.`;

const FIELD_GUIDE = `FIELD GUIDE
xp          expected points for the upcoming gameweek, from the engine
xpHorizon   expected points across the whole planning horizon, discounted for uncertainty
xMins       expected minutes this gameweek -- the strongest signal in the model
haul        probability of returning 10 or more points
pts / form  actual season points, and recent points per game
fixtures    upcoming games as "GW<n> OPP(H)<difficulty>", opponent UPPERCASE at home and lowercase away
flag        present only when there is an injury, suspension or availability concern
owned       percentage of all FPL managers who own the player

TRANSFER OPTIONS
gain    expected points the squad gains across the horizon, before any hit
hitCost points sacrificed to make the move
net     the ranking figure: gain, less the hit, less the value of the transfers spent
vsRoll  how the option compares with banking the transfer instead. Positive means better than doing nothing.`;

export function buildUserPrompt(dataset: AnalysisDataset): string {
  const { engine } = dataset;

  const chipsAvailable =
    dataset.chips.available.length > 0
      ? dataset.chips.available.map((c) => CHIP_LABELS[c]).join(', ')
      : 'none — every chip for this half of the season is already spent';

  const chipsUsed =
    dataset.chips.used.length > 0
      ? dataset.chips.used.map((c) => `${CHIP_LABELS[c.name]} (GW${c.event})`).join(', ')
      : 'none';

  const transferRules = dataset.budget.unlimitedTransfers
    ? `This manager has NOT yet passed their first deadline, so the whole team can still be changed for free. Transfers are unlimited and no hit can apply — set take_hit false and hit_cost 0.`
    : `Free transfers in hand: ${dataset.budget.freeTransfers}. Each transfer beyond that costs ${dataset.meta.hitCost} points.`;

  const rec = engine.recommendation;
  const recLine =
    rec.action === 'hold'
      ? 'HOLD — make no transfer'
      : rec.moves.map((m) => `${m.out} -> ${m.in}`).join(' + ') +
        (rec.takeHit ? ` (taking a -${rec.hitCost} hit)` : ' (no hit)');

  const closeCalls: string[] = [];
  if (engine.transferIsCloseCall) {
    closeCalls.push(
      'TRANSFER: the top options are within the model\'s margin of error. Your judgement decides.',
    );
  }
  if (engine.captainIsCloseCall) {
    closeCalls.push(
      'CAPTAIN: the top two are close enough that either is defensible. Your judgement decides.',
    );
  }

  return `${FIELD_GUIDE}

SITUATION
Gameweek ${dataset.meta.gameweek}, deadline ${new Date(dataset.meta.deadline).toUTCString()}.
Planning horizon: ${dataset.meta.horizonGameweeks} gameweeks. Engine version ${dataset.meta.engineVersion}.
Manager: ${dataset.manager.teamName} — ${dataset.manager.totalPoints} points, overall rank ${
    dataset.manager.overallRank?.toLocaleString('en-GB') ?? 'unranked'
  }.

CONSTRAINTS
${transferRules}
Money in the bank: ${dataset.budget.bankMillions.toFixed(1)}m
Squad value: ${dataset.budget.squadValueMillions.toFixed(1)}m
Chips available: ${chipsAvailable}
Chips already used: ${chipsUsed}
A squad may contain at most 3 players from any one club.

=== THE ENGINE'S RECOMMENDATION ===
Transfer:  ${recLine}
Captain:   ${rec.captain ?? 'none'}   (vice ${rec.viceCaptain ?? 'none'})
Formation: ${rec.formation}
Chip:      ${rec.chip === 'none' ? 'no chip' : CHIP_LABELS[rec.chip]}
This plan projects ${rec.projectedNextGameweek} points for gameweek ${dataset.meta.gameweek}.
${closeCalls.length > 0 ? `\nCLOSE CALLS FOR YOU TO SETTLE\n${closeCalls.map((c) => `- ${c}`).join('\n')}` : '\nThe engine did not flag any close calls.'}

TRANSFER OPTIONS CONSIDERED, BEST FIRST
Every realistic swap was priced against rolling the transfer. Only these were considered legal and affordable.
${JSON.stringify(engine.transferOptions)}

CAPTAIN CANDIDATES
Scored on expectation plus upside, not expectation alone.
${JSON.stringify(engine.captainCandidates)}

CHIP EVALUATIONS
A chip is only worth playing when its value clears its threshold.
${engine.chipEvaluations.length > 0 ? JSON.stringify(engine.chipEvaluations) : 'No chips available.'}

RECOMMENDED LINEUP (${engine.lineup.formation})
Starters: ${JSON.stringify(engine.lineup.starters)}
Bench:    ${JSON.stringify(engine.lineup.bench)}

MY CURRENT SQUAD
Starters: ${JSON.stringify(dataset.squad.starters)}
Bench:    ${JSON.stringify(dataset.squad.bench)}
Current captain: ${dataset.squad.currentCaptain ?? 'not set'}

AVAILABLE REPLACEMENTS BY POSITION
Pre-filtered to players who are affordable, fit and starting regularly. You may only transfer in from this list.
${JSON.stringify(dataset.replacements)}

KNOWN LIMITATIONS
${dataset.caveats.map((c) => `- ${c}`).join('\n')}

Give me my gameweek ${dataset.meta.gameweek} plan. Pick the starting XI and bench from the 15 players I will own after any transfer you recommend.`;
}
