'use client';

import { motion } from 'framer-motion';

import type { TeamSnapshot } from '@/lib/fpl/model';
import { formatPrice, formatRank } from '@/lib/fpl/model';
import { Badge } from '@/components/ui/badge';
import { Countdown } from './Countdown';

interface Props {
  snapshot: TeamSnapshot;
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:px-5">
      <span className="eyebrow">{label}</span>
      <span
        className={`nums text-lg font-bold leading-none ${accent ? 'text-brand' : 'text-text'}`}
      >
        {value}
      </span>
      {hint && <span className="text-[10px] leading-none text-faint">{hint}</span>}
    </div>
  );
}

export function StatusRail({ snapshot }: Props) {
  const { gameweek, finances, manager, chips } = snapshot;

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="panel overflow-hidden"
    >
      <div className="flex flex-col gap-6 border-b border-line px-5 py-5 sm:flex-row sm:items-end sm:justify-between sm:px-6">
        <div className="flex flex-col gap-2">
          <span className="eyebrow">Next deadline</span>
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-extrabold tracking-tight">
              GW{gameweek.id}
            </span>
            <Countdown epoch={gameweek.deadlineEpoch} />
          </div>
          <span className="text-xs text-dim">
            {new Date(gameweek.deadline).toLocaleString(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>

        <div className="flex flex-col gap-1 sm:items-end">
          <span className="eyebrow">Chips left</span>
          <div className="flex flex-wrap gap-1.5">
            {chips.available.length === 0 ? (
              <span className="text-xs text-faint">None remaining</span>
            ) : (
              chips.available.map((chip) => (
                <Badge
                  key={chip}
                  variant="outline"
                  className="border-line-bright bg-white/[0.03] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-dim"
                >
                  {chip === 'bboost'
                    ? 'Bench Boost'
                    : chip === '3xc'
                      ? 'Triple Cap'
                      : chip === 'freehit'
                        ? 'Free Hit'
                        : 'Wildcard'}
                </Badge>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 divide-x divide-y divide-line sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
        <Stat label="Team value" value={formatPrice(finances.teamValue)} />
        <Stat label="Bank" value={formatPrice(finances.bank)} accent={finances.bank > 0} />
        <Stat
          label="Free transfers"
          value={finances.unlimitedTransfers ? 'Unlimited' : String(finances.freeTransfers)}
          accent={finances.unlimitedTransfers}
          hint={
            finances.unlimitedTransfers
              ? 'before your first deadline'
              : finances.freeTransfersInferred
                ? 'derived from history'
                : undefined
          }
        />
        <Stat label="Total points" value={String(manager.overallPoints)} />
        <Stat label="Overall rank" value={formatRank(manager.overallRank)} />
      </div>
    </motion.section>
  );
}
