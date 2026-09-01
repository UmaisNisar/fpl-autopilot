# FPL Autopilot

A personal Fantasy Premier League decision tool. One screen, one button.

Before each deadline you open it, press **Analyze My Team**, and get a single
concrete plan: the transfer to make (or not), who to captain, the starting XI
and bench order, and whether to play a chip.

It is built for one manager — no accounts, no database, no leaderboards.

---

## Setup

```bash
npm install
cp .env.local.example .env.local   # then paste your Gemini key into it
npm run dev
```

Open http://localhost:3000 and enter your FPL manager ID once. It is remembered
in `localStorage` from then on.

### Your manager ID

View your points on the FPL site and read it out of the URL:

```
fantasy.premierleague.com/entry/1234567/event/1
                                ^^^^^^^
```

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes | Free key from https://aistudio.google.com/apikey |
| `GEMINI_MODEL` | no | Defaults to `gemini-2.5-flash` |
| `GEMINI_MOCK` | no | `1` runs a canned plan with no API call, for UI work |
| `NEXT_PUBLIC_DEFAULT_MANAGER_ID` | no | Skips the ID prompt entirely |

---

## Before your first deadline

The public API will not reveal a manager's squad until a deadline has passed for
them. A brand-new team (`entered_events: []`) therefore returns nothing, even
though the team exists — and that is exactly when planning matters most.

The app detects this (`NO_SQUAD`) and opens a squad builder instead: pick your
fifteen once, and it is saved to `localStorage` for that manager ID. In that
state transfers are unlimited and free, so the analysis becomes a squad review —
every change worth making, no hit arithmetic — and the prompt says so
explicitly. Once your first deadline passes the real squad loads from the API
automatically and the builder never appears again.

## How it decides

The model is never asked an open question like "who should I transfer?". A
deterministic engine does the analysis first, and Gemini reviews the result.

```
FPL data ──▶ player projections ──▶ fixture analysis ──▶ transfer evaluation
         ──▶ captain / starting XI ──▶ Gemini reasoning ──▶ final recommendation
```

**1. Expected points** (`src/lib/engine/expected.ts`) models each scoring route
the way FPL actually pays out — appearance, goals, assists, clean sheets, goals
conceded, saves, defensive contributions, bonus and cards — rather than
recycling past points. `npm run verify:scoring` checks the rules against a full
real season and currently matches **11,498 of 11,498 appearances exactly**.

**2. Minutes** (`src/lib/engine/minutes.ts`) is the highest-leverage part. A
weighted-count estimate of selection, with recent games dominating, because a
brilliant player who does not start is worth nothing and most bad advice comes
from projecting a rotation risk as a nailed starter.

**3. Fixtures** (`src/lib/engine/strength.ts`) uses multiplicative team attack
and concede ratings in the style of a Dixon-Coles goals model, fitted on results
so far and shrunk toward a prior derived from FPL's own difficulty ratings —
which matters in August, when two matches would otherwise put a team at triple
the league average. Clean-sheet probability is Poisson from expected goals
conceded, so a defender facing a toothless attack is rewarded for the right
reason.

**4. Transfers** (`src/lib/engine/transfers.ts`) prices every realistic swap
against the option most advice forgets: **banking the transfer**. Options are
scored on the expected points of the whole squad's best XI over five gameweeks,
net of hit costs and of the option value of an unspent transfer. A move must
clear a threshold to be recommended, and a hit a wider one.

**5. Captaincy** (`src/lib/engine/captain.ts`) is scored separately on
expectation *plus upside*, because the armband doubles a score — a defender
projected at 5.5 through clean-sheet probability is a worse captain than a
striker at 5.2 with a real chance of two goals.

**6. Chips** (`src/lib/engine/chips.ts`) are each priced in points against a
threshold. Bench Boost is worth what the bench projects; Triple Captain needs a
captain above the bar. A chip is never recommended for merely being available.

**7. Gemini** receives the finished analysis — the ranked transfer options with
their numbers, captain candidates, chip valuations and the optimal XI — and is
asked to adopt it by default, overrule it only for something the numbers cannot
see (and say what), and settle any call the engine flagged as within its own
margin of error.

**8. Validation** (`src/lib/gemini/validate.ts`) re-checks everything against the
real squad: invented players are dropped, transfers re-checked for
affordability, squad shape and the three-per-club limit, hit cost recomputed
arithmetically, illegal lineups rebuilt. It also reports when the AI departed
from the computed best and roughly what that choice costs. If Gemini is
unreachable, the engine's own plan is shown instead — the real recommendation
minus the explanation.

Every tunable number lives in `src/lib/engine/weights.ts`. Nothing else in the
engine hard-codes a coefficient.

---

## Backtesting

```bash
npm run data:fetch          # cache two seasons of history (gitignored)
npm run backtest            # full suite, recorded against the engine version
npm run backtest:history    # what every version scored
npm run backtest:accuracy   # walk-forward projection accuracy
npm run backtest:calibration # where the model is biased, and which component
npm run backtest:simulate   # play a whole season, decision by decision
npm run backtest:tune       # fit weights on train, validate out of sample
```

Every gameweek is replayed as it looked **before the deadline**.
`assertNoLeakage` re-derives what was read and throws if anything from the
target gameweek reaches the model — including fixture results, which are marked
finished by event number rather than trusted from the file.

### Honest baselines

FPL publishes an expected-points column in the historical data and it is
deliberately **not** used. 64% of players who did not feature carry an `xP` of
exactly zero, which no pre-deadline forecast could know — the scraper snapshots
it after the fact. `scripts/backtest/inspect-baseline.ts` demonstrates this.
What remains are baselines that can only see the past: season points per game,
recent form, the population mean, and a faithful rebuild of the engine this one
replaced.

### Current results

Engine 2.1.0, walk-forward, GW6-38:

| | 2025-26 | 2024-25 (out of sample) |
| --- | --- | --- |
| Rank correlation | 0.499 (v1: 0.469) | 0.533 (v1: 0.512) |
| MAE | 1.657 (v1: 1.742) | 1.491 (v1: 1.558) |
| Top-20 picks, actual pts | 4.56 (v1: 4.42) | 4.76 (v1: 4.78) |
| **Season simulation** | **1833 pts (+98)** | **1978 pts (+165)** |

The simulation is the real test: every strategy starts from the same fifteen
players and walks the season making its own transfers, lineup and captain calls.
`v1-projections` runs the *old* projections through the *current* decision
machinery, so the gap measures the projections alone. The new engine also churns
far less — 33 transfers and 8 points of hits, against 60 transfers and 108 points
of hits for v1, which keeps chasing phantom upgrades in noisier numbers.

### Not overfitting

`npm run backtest:tune` fits on 2025-26 GW6-19 only. The second half of that
season and the whole of 2024-25 are scored but never optimised against, and a
change is only accepted when it improves **both**. The search is coordinate
descent over a small, fixed grid rather than a free-for-all, and seasons are
scored under their own rules — defensive contribution did not exist before
2025/26 and is switched off when testing on earlier data.

`npm run backtest` appends each run to `backtest-results/history.json`, so it is
always possible to answer whether a change actually helped.

---

## Layout

```
src/
  app/
    api/team/route.ts       GET  ?managerId= -> snapshot
                            POST { managerId, squad } -> snapshot from manual entry
    api/players/route.ts    GET  -> selectable players, for the squad builder
    api/analyze/route.ts    POST { managerId, squad? } -> validated plan
    page.tsx
  lib/
    fpl/       client (cached), types, domain model, service, per-player history
    engine/    scoring, minutes, team strength, expected points, squad,
               transfers, captain, chips, weights, plan, live adapter
    analysis/  decision brief for Gemini (display-only legacy projection)
    gemini/    client, prompt, validator, mock
  components/  Dashboard, StatusRail, Pitch, PlanView, AnalyzeButton, SquadBuilder
scripts/
  test-validator.ts        adversarial checks on the AI output validator
  fetch-history.mjs        cache historical seasons
  backtest/                season loader, accuracy, calibration, simulation,
                           tuning, version tracking
```

Responses are cached in-process — fifteen minutes for the player database, an
hour for fixtures, five minutes for your own team — and concurrent requests for
the same resource are collapsed into one fetch.

---

## Caveats

- **Selling prices are approximated with current prices.** The real figure needs
  an authenticated session, so a player whose value has risen may sell for up to
  0.5m less than shown. Plans that depend on the last 0.1m are worth double
  checking.
- **Free transfers are derived, not read.** The logic follows the published
  rules and matches in practice, but it is inference.
- **A manually entered squad is only as right as you typed it.** It lives in
  this browser's `localStorage`; "Edit squad" in the header replaces it.
- Projections are a guide. The tool is decisive on purpose; the decision is
  still yours.
