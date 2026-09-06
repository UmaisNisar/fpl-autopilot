/**
 * Tune the weights that turn projections into decisions.
 *
 * The projection weights were fitted against a statistical proxy. These are
 * different: they decide whether to spend a transfer, whether a hit is worth
 * it, how much a banked transfer is worth, and how much captaincy should chase
 * upside. There is no proxy for those -- the only honest objective is points
 * actually scored, so this optimises a full season simulation directly.
 *
 * Train on one season, validate on the other. A change is accepted only if it
 * holds up on the season it was never fitted to.
 *
 *   npx tsx scripts/backtest/tune-decisions.ts
 */
import { buildWorld, loadSeason, type SeasonData } from './season';
import { simulate } from './simulate';
import { projectAll } from '../../src/lib/engine/plan';
import { DEFAULT_WEIGHTS, ENGINE_VERSION, type Weights } from '../../src/lib/engine/weights';
import type { PositionShort } from '../../src/lib/fpl/types';

const SHAPE: Record<PositionShort, number> = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
const FROM = 6;
const TO = 38;

/** The same starting fifteen for every variant, so only decisions differ. */
function startingSquad(season: SeasonData) {
  const world = buildWorld(season, FROM, DEFAULT_WEIGHTS).world;
  const { projections } = projectAll(world, DEFAULT_WEIGHTS, season.rules);

  const counts: Record<PositionShort, number> = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  const clubs = new Map<number, number>();
  const squad: { id: number; position: PositionShort; teamId: number; price: number }[] = [];
  let spent = 0;

  for (const p of [...projections.values()]
    .filter((p) => p.horizon > 0 && p.price > 0)
    .sort((a, b) => b.horizon / b.price - a.horizon / a.price)) {
    if (squad.length === 15) break;
    if (counts[p.position] >= SHAPE[p.position]) continue;
    if ((clubs.get(p.teamId) ?? 0) >= 3) continue;
    if (spent + p.price + (15 - squad.length - 1) * 4.0 > 100) continue;
    squad.push({ id: p.playerId, position: p.position, teamId: p.teamId, price: p.price });
    counts[p.position] += 1;
    clubs.set(p.teamId, (clubs.get(p.teamId) ?? 0) + 1);
    spent += p.price;
  }
  return squad;
}

const seasons = new Map<string, { season: SeasonData; squad: ReturnType<typeof startingSquad> }>();

function contextFor(name: string) {
  const cached = seasons.get(name);
  if (cached) return cached;
  const season = loadSeason(name);
  const built = { season, squad: startingSquad(season) };
  seasons.set(name, built);
  return built;
}

/** Points actually scored across a simulated season. */
function score(seasonName: string, weights: Weights): number {
  const { season, squad } = contextFor(seasonName);
  return simulate({ season, from: FROM, to: TO, strategy: 'engine', startingSquad: squad, weights })
    .totalPoints;
}

/**
 * The knobs that convert a projection into an action. Kept deliberately short:
 * a season is one sample, so a wide search would fit noise.
 */
const GRID: { key: keyof Weights; values: number[] }[] = [
  // Widened after the first search pinned five of five values to a grid edge,
  // which is the signal that the optimum lay outside the range offered.
  { key: 'freeTransferValue', values: [0, 1.1, 2.5, 4, 6, 8] },
  { key: 'transferThreshold', values: [0, 0.3, 0.6, 1.2] },
  { key: 'hitThreshold', values: [0, 0.25, 0.5, 1.5, 3.0] },
  { key: 'captainUpsideWeight', values: [0.35, 0.75, 1.1, 1.5, 2.0] },
  { key: 'horizonDecay', values: [0.4, 0.5, 0.6, 0.7, 0.86] },
];

const TRAIN = '2025-26';
const VALIDATE = '2024-25';

console.log(`\nDecision-weight tuning — engine ${ENGINE_VERSION}`);
console.log(`train    ${TRAIN} GW${FROM}-${TO}   (objective: season points)`);
console.log(`validate ${VALIDATE} GW${FROM}-${TO}   (never optimised against)\n`);

let best = { ...DEFAULT_WEIGHTS };
let bestScore = score(TRAIN, best);
const baselineTrain = bestScore;
const baselineValidate = score(VALIDATE, best);

console.log(`Current weights: ${baselineTrain} pts train, ${baselineValidate} pts validate\n`);
console.log('Search trail');

for (let pass = 0; pass < 2; pass++) {
  let improved = false;

  for (const { key, values } of GRID) {
    let localBest = best[key] as number;
    let localScore = bestScore;

    for (const value of values) {
      if (value === best[key]) continue;
      const candidate = { ...best, [key]: value };
      const points = score(TRAIN, candidate);
      if (points > localScore) {
        localBest = value;
        localScore = points;
      }
    }

    if (localBest !== best[key]) {
      console.log(
        `  pass ${pass + 1}: ${String(key)} ${String(best[key])} -> ${localBest}   ${bestScore} -> ${localScore} pts`,
      );
      best = { ...best, [key]: localBest };
      bestScore = localScore;
      improved = true;
    }
  }

  if (!improved) break;
}

const tunedValidate = score(VALIDATE, best);
const changed = (Object.keys(best) as (keyof Weights)[]).filter(
  (k) => best[k] !== DEFAULT_WEIGHTS[k],
);

console.log('\nChanged values');
if (changed.length === 0) console.log('  none — the current weights already win');
for (const key of changed) {
  console.log(`  ${String(key).padEnd(22)} ${String(DEFAULT_WEIGHTS[key])} -> ${String(best[key])}`);
}

const trainGain = bestScore - baselineTrain;
const validateGain = tunedValidate - baselineValidate;

console.log(`\nSeason points`);
console.log(`  train     ${baselineTrain} -> ${bestScore}   (${trainGain >= 0 ? '+' : ''}${trainGain})`);
console.log(
  `  validate  ${baselineValidate} -> ${tunedValidate}   (${validateGain >= 0 ? '+' : ''}${validateGain})`,
);
console.log(
  validateGain > 0
    ? '\n  ACCEPT — holds up on the season it was not fitted to\n'
    : '\n  REJECT — does not transfer to the held-out season\n',
);

if (validateGain > 0) {
  console.log('Paste into DEFAULT_WEIGHTS:');
  for (const key of changed) console.log(`  ${String(key)}: ${String(best[key])},`);
  console.log();
}
