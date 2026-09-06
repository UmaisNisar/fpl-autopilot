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
| `NEXT_PUBLIC_DEFAULT_SQUAD` | no | 15 player ids, for before your first deadline |
| `NEXT_PUBLIC_DEFAULT_BANK` | no | Money in the bank, in millions, to pair with the squad above |
| `ALLOWED_MANAGER_IDS` | no | Comma-separated ids this deployment will serve. Unset means unrestricted |

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

## UI

Tailwind CSS v4, Framer Motion, and **shadcn/ui** on Radix primitives.

shadcn's components are written against semantic CSS variables
(`--background`, `--primary`, `--border`), so rather than accept its default
grey those are pointed at this app's own palette in `globals.css`. A `Button`
therefore arrives already looking like it belongs here, with no per-component
overrides.

One collision is worth knowing about: shadcn's `--accent` means the muted
*hover surface*, not a brand colour. This app's green was renamed to `brand`
(and its `muted` text colour to `dim`) so the two systems can coexist without
either quietly restyling the other.

### Showing the working

The engine computes far more than a single recommendation, so the UI shows it.
Under the plan, **Why this plan** lays out the ranked transfer options with what
each is worth against banking the transfer, the captain candidates scored on
expectation *plus* upside, and every chip's valuation against its threshold.
Each player on the pitch carries its expected points as a bar and a figure.

This is what makes the advice checkable: "make this transfer" becomes "make this
transfer, and here is what the alternatives were worth".

Bespoke components stay bespoke — the pitch, the analyse button and the `.panel`
surface are the design, not generic furniture. shadcn is used where it earns
its place: focus rings, keyboard-navigable tabs, a real scroll area and
tooltips that work on touch.

Add more with `npx shadcn@latest add <component>`.

---

## Deployment

Live at **https://fpl-autopilot-seven.vercel.app**, deployed from
`UmaisNisar/fpl-autopilot` on Vercel.

Two things matter for a public deployment of a single-user tool:

- `ALLOWED_MANAGER_IDS` locks the API to one team. Any other manager id gets a
  403, so a stray visitor cannot spend the owner's Gemini quota browsing other
  people's squads.
- `GEMINI_API_KEY` lives only in Vercel's environment. It is never committed;
  `.env.local` is gitignored and `.env.local.example` is the template.

Redeploy with `npx vercel deploy --prod`, or push to `main` if the GitHub
integration is connected.

### What the API can and cannot see

FPL publishes nothing about a gameweek that has not kicked off. Transfers you
make for the upcoming deadline, and the bank and free transfers that go with
them, appear only **after** that deadline passes. `/entry/{id}/transfers/`
returns nothing for them and `last_deadline_bank` is exactly what it says.

So an API-sourced squad is always your team **as it stood at the last
deadline** — which the status rail now says out loud rather than presenting as
current. **Update squad** lets you correct it: the fifteen come pre-filled, and
you state the bank and free transfers, both of which are on the FPL transfers
page.

A correction records the gameweek it was made for and expires with it. Once
that deadline passes the API knows the real team, so keeping a hand-entered one
would show a squad that has since changed.

### Before your first deadline

The public API will not reveal a squad until the manager has had a deadline
pass. Setting `NEXT_PUBLIC_DEFAULT_SQUAD` and `NEXT_PUBLIC_DEFAULT_BANK` pins
the fifteen so the app opens straight onto the team on any device, instead of
asking for them again.

The API is always asked **first**, and a pinned or hand-entered squad is used
only when it answers `NO_SQUAD`. Once that first deadline passes the real squad
takes over automatically and any stored stand-in is discarded, so a hand-typed
team cannot outlive its usefulness.

Bank has to be stated rather than derived. FPL locks in what you paid, so a
player rising 0.1m raises your squad value without touching your bank —
deriving it from current prices under-reports the budget by the total rise.

---

## Applying the plan

FPL has no supported way for an app to change your team. The old scripted login
at `users.premierleague.com/accounts/login/` — the endpoint every third-party
FPL tool used — no longer resolves at all; authentication has moved to Firebase
behind `account.premierleague.com`, which returns 403 to anything that is not a
browser. The write endpoints (`/api/my-team/`, `/api/transfers/`) exist but need
a live browser session.

Working around that means storing someone's session cookie or shipping a browser
extension, and neither is worth it to save half a minute. So the app does the
next best thing: **Apply on FPL** lists exactly what to click and deep-links to
the right screen.

It shows only what *changes* — "start these two, bench that one", not a list of
all fifteen — with a checkbox per step, a copy-to-clipboard for reading on a
phone, and a per-step tag for whether it happens on the Transfers or My Team
page. A player leaving in a transfer is never listed as one to bench.

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

Engine 2.2.0, walk-forward, GW6-38:

| | 2025-26 | 2024-25 (out of sample) |
| --- | --- | --- |
| Rank correlation | 0.499 (v1: 0.469) | 0.533 (v1: 0.512) |
| Top-20 picks, actual pts | 4.55 (v1: 4.42) | 4.76 (v1: 4.78) |
| **Season simulation** | **1959 pts (+187)** | **2068 pts (+209)** |

### Two weight sets, two objectives

**Projection weights** are fitted by `npm run backtest:tune` against a
statistical proxy. That objective originally subtracted MAE, which turned out
to be a trap: most players score near zero, so on that distribution MAE rewards
under-prediction. It bought 0.02 of rank correlation and paid with 2.4x the
calibration error. Bias is penalised explicitly now.

**Decision weights** -- when to spend a transfer, when a hit is worth it, what a
banked transfer is worth, how far captaincy should chase upside -- have no
proxy. `npm run tune:decisions` optimises a full season simulation directly on
points scored, fits on one season and validates on the other. Doing that was
worth **+146 points** on the season it was never fitted to.

**Calibration** (`npm run fit:calibration`) is an affine, therefore
rank-preserving, rescale fitted on the first half of both seasons. The raw model
under-called badly -- a projection of 5.4 was worth 6.5 -- which mattered once
those numbers went on screen and started being compared against fixed chip
thresholds. Rank correlation is unchanged by construction; |bias| drops from
0.31 to 0.17 on held-out data and from 0.73 to 0.23 early in a season.

### A negative result worth keeping

Last season's data is loaded and plumbed through, but weighted at **zero**.
Measured on held-out data, last season's *rates* moved rank correlation by
0.001 -- nothing. Last season's *start rate* did fix calibration (bias -0.402 to
-0.139) but cost 0.043 of rank correlation, because a player's role moves
between seasons and last year's start rate blurs who is being picked now. The
calibration layer buys the same correction while preserving order, which is
strictly the better trade. The switch is left in place because it is what
produced the measurement.

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
  components/  Dashboard, StatusRail, Pitch, PlanView, AnalyzeButton, SquadBuilder,
               EngineBreakdown
    ui/        shadcn/ui primitives (button, input, badge, tabs, tooltip, ...)
scripts/
  test-validator.ts        adversarial checks on the AI output validator
  fetch-history.mjs        cache historical seasons
  backtest/                season loader, accuracy, calibration, simulation,
                           tuning, version tracking
```

Shared reference data (players, fixtures) is cached both in-process and in
Next's persistent fetch cache — fifteen minutes and an hour respectively.

A manager's own entry, picks and history are deliberately **not** in the
persistent cache. They change the moment a transfer is made or a gameweek ticks
over, and a copy surviving a restart is how the app once reported 0 points for a
team that had already played. They are held only in a sixty-second in-process
memo, and the refresh control beside the squad clears even that.

Concurrent requests for the same resource are collapsed into one fetch.

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
