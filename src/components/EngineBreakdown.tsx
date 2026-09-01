'use client';

import { motion } from 'framer-motion';

import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CHIP_LABELS } from '@/lib/fpl/model';
import type { EngineBrief } from '@/lib/gemini/plan';

/**
 * The engine's working, shown rather than taken on trust.
 *
 * Everything here was already computed to produce the plan -- the ranked
 * transfer options, the captaincy scores, the chip valuations. Showing it turns
 * "make this transfer" into "make this transfer, and here is what the
 * alternatives were worth".
 */

interface Props {
  engine: EngineBrief;
  /** Names in the plan that was actually chosen, to highlight the row. */
  chosenMoves: { out: string; in: string }[];
  captain: string;
}

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as const } },
};

/** Bar scaled against the best option, so the leader always fills the track. */
function ValueBar({ value, max, tone }: { value: number; max: number; tone: string }) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div variants={item} className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="eyebrow">{title}</span>
        {hint && <span className="text-[10px] text-faint">{hint}</span>}
      </div>
      {children}
    </motion.div>
  );
}

export function EngineBreakdown({ engine, chosenMoves, captain }: Props) {
  const chosenKey = chosenMoves.map((m) => `${m.out}>${m.in}`).join(',');

  // Rolling is the baseline every other row is measured against, so it is
  // always shown even when four better moves crowd it out of the ranking.
  const roll = engine.transferOptions.find((o) => o.moves.length === 0);
  const moves = engine.transferOptions.filter((o) => o.moves.length > 0).slice(0, 4);
  const options = roll ? [...moves, roll] : moves;
  const bestGain = Math.max(0.1, ...options.map((o) => Math.abs(o.vsRoll)));
  const bestCaptain = Math.max(0.1, ...engine.captainCandidates.map((c) => c.score));

  return (
    <motion.section
      variants={{ hidden: {}, show: { transition: { staggerChildren: 0.08 } } }}
      initial="hidden"
      animate="show"
      className="panel flex flex-col gap-7 px-5 py-6 sm:px-8 sm:py-7"
    >
      <motion.header variants={item} className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-bold tracking-tight">Why this plan</h3>
        <Badge variant="outline" className="border-line-bright text-[10px] text-faint">
          engine {engine.version} · {engine.projectedPoints.toFixed(1)} pts projected
        </Badge>
      </motion.header>

      {/* --- Transfers considered ------------------------------------------ */}
      <Section
        title="Transfer options"
        hint="every legal move, priced against banking the transfer"
      >
        <Table>
          <TableHeader>
            <TableRow className="border-line hover:bg-transparent">
              <TableHead className="h-8 text-[10px] uppercase tracking-wider text-faint">
                Move
              </TableHead>
              <TableHead className="h-8 w-20 text-right text-[10px] uppercase tracking-wider text-faint">
                Gain
              </TableHead>
              <TableHead className="h-8 w-16 text-right text-[10px] uppercase tracking-wider text-faint">
                Hit
              </TableHead>
              <TableHead className="h-8 w-32 text-[10px] uppercase tracking-wider text-faint">
                vs rolling
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {options.map((option) => {
              const key = option.moves.map((m) => `${m.out}>${m.in}`).join(',');
              const isChosen = key === chosenKey;
              const isRoll = option.moves.length === 0;

              return (
                <TableRow
                  key={option.label}
                  className={`border-line ${isChosen ? 'bg-brand/[0.06]' : ''}`}
                >
                  <TableCell className="py-2 text-xs font-semibold">
                    <span className="flex items-center gap-2">
                      {isChosen && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                      )}
                      <span className={isRoll ? 'text-dim' : ''}>{option.label}</span>
                    </span>
                  </TableCell>
                  <TableCell className="nums py-2 text-right text-xs">
                    {option.gain > 0 ? `+${option.gain.toFixed(1)}` : option.gain.toFixed(1)}
                  </TableCell>
                  <TableCell className="nums py-2 text-right text-xs">
                    {option.hitCost > 0 ? (
                      <span className="text-amber">-{option.hitCost}</span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </TableCell>
                  <TableCell className="py-2">
                    <div className="flex items-center gap-2">
                      <ValueBar
                        value={Math.max(0, option.vsRoll)}
                        max={bestGain}
                        tone={option.vsRoll > 0 ? 'bg-brand' : 'bg-white/20'}
                      />
                      <span
                        className={`nums w-10 shrink-0 text-right text-[11px] ${
                          option.vsRoll > 0 ? 'text-brand' : 'text-faint'
                        }`}
                      >
                        {option.vsRoll > 0 ? '+' : ''}
                        {option.vsRoll.toFixed(1)}
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {engine.transferIsCloseCall && (
          <p className="text-[11px] leading-relaxed text-amber/80">
            The top options are within the model&rsquo;s margin of error, so this one was a
            judgement call rather than a clear winner.
          </p>
        )}
      </Section>

      {/* --- Captaincy ------------------------------------------------------ */}
      <Section title="Captain candidates" hint="scored on expectation plus upside, not mean alone">
        <div className="flex gap-3 pl-2.5 text-[10px] text-faint">
          <span className="w-28 shrink-0" />
          <span className="flex-1">captaincy score</span>
          <span className="w-11 text-right">xP</span>
          <span className="w-11 text-right">ceiling</span>
          <span className="w-10 text-right">haul</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {engine.captainCandidates.map((candidate) => {
            const isPick = candidate.name === captain;
            return (
              <div
                key={candidate.name}
                className={`flex items-center gap-3 rounded-lg px-2.5 py-2 ${
                  isPick ? 'bg-violet/[0.08]' : ''
                }`}
              >
                <span
                  className={`w-28 shrink-0 truncate text-xs font-semibold ${
                    isPick ? 'text-violet' : ''
                  }`}
                >
                  {isPick && <span className="mr-1.5 text-[10px]">C</span>}
                  {candidate.name}
                </span>

                <div className="flex-1">
                  <ValueBar
                    value={candidate.score}
                    max={bestCaptain}
                    tone={isPick ? 'bg-violet' : 'bg-white/20'}
                  />
                </div>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="nums w-11 shrink-0 text-right text-[11px] text-dim">
                      {candidate.expected.toFixed(1)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Expected points this gameweek</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="nums w-11 shrink-0 text-right text-[11px] text-faint">
                      {candidate.ceiling.toFixed(1)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Ceiling — roughly a 90th-percentile week</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={`nums w-10 shrink-0 text-right text-[11px] ${
                        candidate.haulProbability >= 0.2 ? 'text-brand' : 'text-faint'
                      }`}
                    >
                      {Math.round(candidate.haulProbability * 100)}%
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Chance of returning 10 or more points</TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </Section>

      {/* --- Chips ---------------------------------------------------------- */}
      {engine.chipEvaluations.length > 0 && (
        <Section title="Chip valuations" hint="a chip is only played when it clears its bar">
          <div className="flex flex-col gap-2.5">
            {engine.chipEvaluations.map((chip) => {
              const pct = Math.max(0, Math.min(100, (chip.value / chip.threshold) * 100));
              return (
                <div key={chip.chip} className="flex items-center gap-3">
                  <span className="w-24 shrink-0 text-xs font-semibold">
                    {CHIP_LABELS[chip.chip]}
                  </span>
                  <div className="flex-1">
                    {/* The indicator is styled through its data-slot so the
                        vendored component stays untouched by `shadcn add`. */}
                    <Progress
                      value={pct}
                      className={`h-1.5 bg-white/[0.06] ${
                        chip.recommended
                          ? '[&_[data-slot=progress-indicator]]:bg-brand'
                          : '[&_[data-slot=progress-indicator]]:bg-white/25'
                      }`}
                    />
                  </div>
                  <span className="nums w-24 shrink-0 text-right text-[11px] text-dim">
                    {chip.value.toFixed(1)} / {chip.threshold}
                  </span>
                  <span className="hidden w-56 shrink-0 truncate text-[11px] text-faint sm:block">
                    {chip.reason}
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </motion.section>
  );
}
