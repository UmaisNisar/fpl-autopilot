'use client';

import { motion } from 'framer-motion';

interface Props {
  onClick: () => void;
  busy: boolean;
  hasResult: boolean;
}

/** The primary interaction. Everything else on the page exists to feed it. */
export function AnalyzeButton({ onClick, busy, hasResult }: Props) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={busy}
      whileHover={busy ? undefined : { scale: 1.01 }}
      whileTap={busy ? undefined : { scale: 0.99 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      className="group relative w-full overflow-hidden rounded-2xl border border-accent/30 bg-accent/[0.06] px-6 py-6 text-center transition-colors hover:border-accent/60 hover:bg-accent/[0.1] disabled:cursor-wait"
    >
      {/* Sweep that only runs while the model is thinking. */}
      {busy && (
        <motion.span
          aria-hidden
          className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-accent/15 to-transparent"
          initial={{ x: '-120%' }}
          animate={{ x: '420%' }}
          transition={{ duration: 1.3, repeat: Infinity, ease: 'linear' }}
        />
      )}

      <span className="relative flex items-center justify-center gap-3">
        <span className="text-xl">{busy ? '◐' : '⚡'}</span>
        <span className="text-lg font-extrabold uppercase tracking-[0.14em] text-accent sm:text-xl">
          {busy ? 'Analysing…' : hasResult ? 'Re-analyse my team' : 'Analyze my team'}
        </span>
      </span>

      <span className="relative mt-1.5 block text-[11px] text-muted">
        {busy
          ? 'Reading fixtures, form and your squad'
          : 'Transfers, captain, XI, bench and chips — one plan'}
      </span>
    </motion.button>
  );
}
