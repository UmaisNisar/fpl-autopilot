'use client';

import { AnimatePresence, motion } from 'framer-motion';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { SquadPlayer } from '@/lib/fpl/model';
import type { PositionShort } from '@/lib/fpl/types';

/** Engine numbers per player id, so each card can show what it is worth. */
export interface PitchMetrics {
  [playerId: number]: { xp: number; xpHorizon: number; xMins: number; haul: number };
}

export interface PitchState {
  startingXi: SquadPlayer[];
  bench: SquadPlayer[];
  captainId: number | null;
  viceCaptainId: number | null;
  formation: string;
  /** Players arriving via the recommended transfer. */
  incomingIds?: number[];
  /** Players leaving via the recommended transfer, shown beside the bench. */
  outgoing?: SquadPlayer[];
  /** Expected points and minutes, shown on each card once analysis has run. */
  metrics?: PitchMetrics;
}

const ROWS: PositionShort[] = ['GKP', 'DEF', 'MID', 'FWD'];

/** Fixture difficulty 1 (easiest) to 5 (hardest). */
const FDR_STYLE: Record<number, string> = {
  1: 'bg-brand/15 text-brand',
  2: 'bg-brand/10 text-brand/80',
  3: 'bg-white/[0.06] text-dim',
  4: 'bg-amber/10 text-amber',
  5: 'bg-rose/15 text-rose',
};

function badgeUrl(teamCode: number) {
  return `https://resources.premierleague.com/premierleague/badges/70/t${teamCode}.png`;
}

function NextFixture({ player }: { player: SquadPlayer }) {
  const next = player.fixtures[0];
  if (!next) {
    return (
      <span className="rounded bg-rose/15 px-1.5 py-px text-[9px] font-bold uppercase text-rose">
        Blank
      </span>
    );
  }

  // A double gameweek is worth calling out on the card itself.
  const sameWeek = player.fixtures.filter((f) => f.event === next.event);
  const label = sameWeek
    .map((f) => `${f.opponent}${f.isHome ? '' : ' (a)'}`)
    .join(' + ');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wide ${
            FDR_STYLE[next.difficulty] ?? FDR_STYLE[3]
          }`}
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Gameweek {next.event} · difficulty {next.difficulty} of 5
      </TooltipContent>
    </Tooltip>
  );
}

interface CardProps {
  player: SquadPlayer;
  captain?: boolean;
  vice?: boolean;
  incoming?: boolean;
  benched?: boolean;
  benchIndex?: number;
  metric?: { xp: number; xpHorizon: number; xMins: number; haul: number };
  /** Highest expected points in the squad, so the bars share a scale. */
  scaleMax?: number;
}

function PlayerCard({
  player,
  captain,
  vice,
  incoming,
  benched,
  benchIndex,
  metric,
  scaleMax,
}: CardProps) {
  const unavailable = player.status !== 'a';

  return (
    <motion.div
      layout
      layoutId={`player-${player.id}`}
      transition={{ type: 'spring', stiffness: 320, damping: 34 }}
      className={`group relative flex w-[63px] flex-col items-center gap-1 rounded-lg border px-1 pb-1.5 pt-2 backdrop-blur-sm transition-colors sm:w-[86px] sm:px-1.5 ${
        incoming
          ? 'border-brand/60 bg-brand/[0.08]'
          : captain
            ? 'border-violet/50 bg-violet/[0.07]'
            : 'border-white/[0.07] bg-black/40 hover:border-white/[0.14]'
      } ${benched ? 'opacity-70' : ''}`}
    >
      {(captain || vice) && (
        <span
          className={`absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-extrabold ${
            captain ? 'bg-violet text-void' : 'bg-white/20 text-text'
          }`}
        >
          {captain ? 'C' : 'V'}
        </span>
      )}

      {incoming && (
        <span className="absolute -left-1.5 -top-1.5 rounded-full bg-brand px-1.5 py-px text-[9px] font-extrabold text-void">
          IN
        </span>
      )}

      {benchIndex !== undefined && (
        <span className="absolute -left-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-line-bright bg-ink text-[10px] font-bold text-dim">
          {benchIndex}
        </span>
      )}

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={badgeUrl(player.teamCode)}
        alt=""
        width={22}
        height={22}
        loading="lazy"
        className="h-[22px] w-[22px] object-contain opacity-90"
        onError={(e) => {
          e.currentTarget.style.visibility = 'hidden';
        }}
      />

      <span className="w-full truncate text-center text-[11px] font-semibold leading-tight">
        {player.name}
      </span>

      <div className="flex w-full items-center justify-center gap-1.5">
        <span className="text-[9px] font-bold uppercase tracking-wider text-faint">
          {player.position}
        </span>
        <span className="nums text-[9px] text-dim">£{player.price.toFixed(1)}</span>
        {unavailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="h-1.5 w-1.5 rounded-full bg-rose" />
            </TooltipTrigger>
            <TooltipContent className="max-w-56">
              {player.news || 'Availability doubt'}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <NextFixture player={player} />

      {/* Expected points, once the engine has run. The bar is scaled to the
          best player in the squad so the cards are comparable at a glance. */}
      {metric && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="mt-0.5 flex w-full flex-col gap-1">
              <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/[0.07]">
                <div
                  className={`h-full rounded-full ${captain ? 'bg-violet' : 'bg-brand'}`}
                  style={{
                    width: `${Math.max(4, Math.min(100, (metric.xp / Math.max(0.1, scaleMax ?? metric.xp)) * 100))}%`,
                  }}
                />
              </div>
              <span className="nums text-center text-[9px] leading-none text-dim">
                {metric.xp.toFixed(1)} xP
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent className="text-xs">
            <span className="nums">
              {metric.xp.toFixed(1)} expected points · {metric.xMins} mins ·{' '}
              {Math.round(metric.haul * 100)}% haul
            </span>
          </TooltipContent>
        </Tooltip>
      )}
    </motion.div>
  );
}

export function Pitch({ state }: { state: PitchState }) {
  const incoming = new Set(state.incomingIds ?? []);
  const metrics = state.metrics;
  const scaleMax = metrics
    ? Math.max(
        0.1,
        ...[...state.startingXi, ...state.bench].map((p) => metrics[p.id]?.xp ?? 0),
      )
    : undefined;

  return (
    <div className="flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-[14px] border border-line bg-[#060a08]">
        {/* Pitch markings, deliberately faint. */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(0,229,160,0.06),transparent_60%)]" />
          <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-white/[0.04]" />
          <div className="absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/[0.04]" />
          <div className="absolute left-1/2 top-0 h-16 w-40 -translate-x-1/2 rounded-b-md border-x border-b border-white/[0.04]" />
          <div className="absolute bottom-0 left-1/2 h-16 w-40 -translate-x-1/2 rounded-t-md border-x border-t border-white/[0.04]" />
        </div>

        <div className="relative flex flex-col justify-between gap-5 px-2 py-6 sm:px-6 sm:py-8">
          {ROWS.map((row) => {
            const players = state.startingXi.filter((p) => p.position === row);
            if (players.length === 0) return null;
            return (
              <div key={row} className="flex flex-wrap items-start justify-center gap-1.5 sm:gap-3">
                <AnimatePresence mode="popLayout">
                  {players.map((player) => (
                    <PlayerCard
                      key={player.id}
                      player={player}
                      captain={player.id === state.captainId}
                      vice={player.id === state.viceCaptainId}
                      incoming={incoming.has(player.id)}
                      metric={metrics?.[player.id]}
                      scaleMax={scaleMax}
                    />
                  ))}
                </AnimatePresence>
              </div>
            );
          })}
        </div>

        <div className="relative border-t border-white/[0.06] bg-black/40 px-2 py-3 sm:px-6">
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Bench — substitution order</span>
            <span className="nums text-[10px] text-faint">{state.formation}</span>
          </div>
          <div className="flex flex-wrap items-start gap-1.5 sm:gap-3">
            <AnimatePresence mode="popLayout">
              {state.bench.map((player, index) => (
                <PlayerCard
                  key={player.id}
                  player={player}
                  benched
                  incoming={incoming.has(player.id)}
                  benchIndex={player.position === 'GKP' ? undefined : index}
                  metric={metrics?.[player.id]}
                  scaleMax={scaleMax}
                />
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {state.outgoing && state.outgoing.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-wrap items-center gap-3 rounded-lg border border-rose/20 bg-rose/[0.04] px-4 py-3"
        >
          <span className="eyebrow text-rose/70">Leaving your squad</span>
          {state.outgoing.map((player) => (
            <span key={player.id} className="text-sm font-semibold text-rose line-through">
              {player.name}
            </span>
          ))}
        </motion.div>
      )}
    </div>
  );
}
