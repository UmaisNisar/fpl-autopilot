'use client';

import { AnimatePresence, motion } from 'framer-motion';

import type { SquadPlayer } from '@/lib/fpl/model';
import type { PositionShort } from '@/lib/fpl/types';

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
}

const ROWS: PositionShort[] = ['GKP', 'DEF', 'MID', 'FWD'];

/** Fixture difficulty 1 (easiest) to 5 (hardest). */
const FDR_STYLE: Record<number, string> = {
  1: 'bg-accent/15 text-accent',
  2: 'bg-accent/10 text-accent/80',
  3: 'bg-white/[0.06] text-muted',
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
    <span
      className={`rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wide ${
        FDR_STYLE[next.difficulty] ?? FDR_STYLE[3]
      }`}
      title={`Gameweek ${next.event} · difficulty ${next.difficulty}`}
    >
      {label}
    </span>
  );
}

interface CardProps {
  player: SquadPlayer;
  captain?: boolean;
  vice?: boolean;
  incoming?: boolean;
  benched?: boolean;
  benchIndex?: number;
}

function PlayerCard({ player, captain, vice, incoming, benched, benchIndex }: CardProps) {
  const unavailable = player.status !== 'a';

  return (
    <motion.div
      layout
      layoutId={`player-${player.id}`}
      transition={{ type: 'spring', stiffness: 320, damping: 34 }}
      className={`group relative flex w-[63px] flex-col items-center gap-1 rounded-lg border px-1 pb-1.5 pt-2 backdrop-blur-sm transition-colors sm:w-[86px] sm:px-1.5 ${
        incoming
          ? 'border-accent/60 bg-accent/[0.08]'
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
        <span className="absolute -left-1.5 -top-1.5 rounded-full bg-accent px-1.5 py-px text-[9px] font-extrabold text-void">
          IN
        </span>
      )}

      {benchIndex !== undefined && (
        <span className="absolute -left-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-line-bright bg-ink text-[10px] font-bold text-muted">
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
        <span className="nums text-[9px] text-muted">£{player.price.toFixed(1)}</span>
        {unavailable && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-rose"
            title={player.news || 'Availability doubt'}
          />
        )}
      </div>

      <NextFixture player={player} />
    </motion.div>
  );
}

export function Pitch({ state }: { state: PitchState }) {
  const incoming = new Set(state.incomingIds ?? []);

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
