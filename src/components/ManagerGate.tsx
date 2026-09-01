'use client';

import { motion } from 'framer-motion';
import { useState } from 'react';

interface Props {
  onSubmit: (managerId: number) => void;
  error?: string | null;
  busy?: boolean;
}

/** First-run screen: the only thing this app ever asks for. */
export function ManagerGate({ onSubmit, error, busy }: Props) {
  const [value, setValue] = useState('');
  const parsed = Number(value.trim());
  const valid = Number.isInteger(parsed) && parsed > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="mx-auto flex min-h-[78vh] w-full max-w-md flex-col items-center justify-center gap-7 text-center"
    >
      <div className="flex flex-col gap-3">
        <h1 className="text-4xl font-extrabold tracking-tight">FPL Autopilot</h1>
        <p className="text-sm leading-relaxed text-muted">
          One button, one decision. Enter your manager ID to load your squad.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) onSubmit(parsed);
        }}
        className="flex w-full flex-col gap-3"
      >
        <input
          autoFocus
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="1234567"
          aria-label="FPL manager ID"
          className="nums w-full rounded-xl border border-line bg-white/[0.03] px-4 py-3.5 text-center text-lg tracking-widest outline-none transition-colors placeholder:text-faint focus:border-accent/50 focus:bg-white/[0.05]"
        />

        <button
          type="submit"
          disabled={!valid || busy}
          className="w-full rounded-xl bg-accent px-4 py-3.5 text-sm font-bold uppercase tracking-wider text-void transition-opacity disabled:opacity-30"
        >
          {busy ? 'Loading squad…' : 'Load my team'}
        </button>
      </form>

      {error && <p className="text-sm text-rose">{error}</p>}

      <p className="max-w-sm text-xs leading-relaxed text-faint">
        Find it in the URL when you view your points on the FPL site:
        <br />
        <span className="nums">fantasy.premierleague.com/entry/</span>
        <span className="nums text-muted">1234567</span>
        <span className="nums">/event/1</span>
      </p>
    </motion.div>
  );
}
