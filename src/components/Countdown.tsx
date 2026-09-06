'use client';

import { useEffect, useState } from 'react';

interface Props {
  /** Deadline as epoch seconds. */
  epoch: number;
}

function split(msRemaining: number) {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Live countdown to the deadline. Renders nothing time-dependent until mounted
 * so the server and client markup always agree.
 */
export function Countdown({ epoch }: Props) {
  const [now, setNow] = useState<number | null>(null);

  // The clock is an external source, and reading it during render would make
  // the server and client markup disagree. Deferring it to an effect is the
  // point: nothing time-dependent renders until after mount.
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (now === null) {
    return <span className="nums text-2xl tabular-nums text-faint">--:--:--</span>;
  }

  const remaining = epoch * 1000 - now;
  if (remaining <= 0) {
    return <span className="nums text-2xl font-bold text-rose">DEADLINE PASSED</span>;
  }

  const { days, hours, minutes, seconds } = split(remaining);
  const urgent = remaining < 6 * 3600 * 1000;

  return (
    <span
      className={`nums text-2xl font-bold tracking-tight transition-colors ${
        urgent ? 'text-amber' : 'text-text'
      }`}
    >
      {days > 0 && <span>{days}d </span>}
      {pad(hours)}:{pad(minutes)}:{pad(seconds)}
    </span>
  );
}
