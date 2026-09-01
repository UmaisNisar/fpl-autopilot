'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';

import type { PositionShort } from '@/lib/fpl/types';
import type { ManualSquad } from '@/lib/fpl/model';

export interface PlayerOption {
  id: number;
  name: string;
  team: string;
  teamCode: number;
  pos: PositionShort;
  price: number;
  points: number;
  form: number;
  owned: number;
  flag?: string;
}

const SHAPE: Record<PositionShort, number> = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
const POSITIONS: PositionShort[] = ['GKP', 'DEF', 'MID', 'FWD'];
const BUDGET = 100.0;
const MAX_PER_CLUB = 3;

type SortKey = 'points' | 'price' | 'form';

interface Props {
  /** Shown in the heading when known. */
  gameweek?: number;
  reason: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (squad: ManualSquad) => void;
  onCancel: () => void;
}

/**
 * Manual squad entry.
 *
 * Needed because the public FPL API will not reveal a manager's team until
 * their first deadline has passed. Enforces the same rules the game does, so
 * whatever leaves here is a legal squad.
 */
export function SquadBuilder({ gameweek, reason, busy, error, onSubmit, onCancel }: Props) {
  const [players, setPlayers] = useState<PlayerOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PlayerOption[]>([]);
  const [tab, setTab] = useState<PositionShort>('GKP');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('points');

  useEffect(() => {
    let live = true;
    fetch('/api/players')
      .then(async (res) => {
        const body = (await res.json()) as { players?: PlayerOption[]; error?: string };
        if (!live) return;
        if (!res.ok || !body.players) throw new Error(body.error ?? 'Could not load players.');
        setPlayers(body.players);
      })
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, []);

  const spent = selected.reduce((sum, p) => sum + p.price, 0);
  const remaining = Math.round((BUDGET - spent) * 10) / 10;
  const counts = useMemo(() => {
    const c: Record<PositionShort, number> = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const p of selected) c[p.pos] += 1;
    return c;
  }, [selected]);

  const clubCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const p of selected) c.set(p.team, (c.get(p.team) ?? 0) + 1);
    return c;
  }, [selected]);

  const complete = selected.length === 15;
  const shapeOk = POSITIONS.every((pos) => counts[pos] === SHAPE[pos]);
  const canSubmit = complete && shapeOk && remaining >= -0.001 && !busy;

  const visible = useMemo(() => {
    if (!players) return [];
    const q = query.trim().toLowerCase();
    return players
      .filter((p) => p.pos === tab)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q))
      .sort((a, b) =>
        sort === 'price' ? b.price - a.price : sort === 'form' ? b.form - a.form : b.points - a.points,
      )
      .slice(0, 60);
  }, [players, tab, query, sort]);

  function toggle(player: PlayerOption) {
    const already = selected.some((p) => p.id === player.id);
    if (already) {
      setSelected((s) => s.filter((p) => p.id !== player.id));
      return;
    }
    if (counts[player.pos] >= SHAPE[player.pos]) return;
    if ((clubCounts.get(player.team) ?? 0) >= MAX_PER_CLUB) return;
    setSelected((s) => [...s, player]);
  }

  function submit() {
    if (!canSubmit) return;
    // Order matters: the first 11 become the starting XI. Send a legal 3-4-3
    // and let the optimiser and the model reshape it from there.
    const byPos = (pos: PositionShort) =>
      selected.filter((p) => p.pos === pos).sort((a, b) => b.points - a.points);

    const gk = byPos('GKP');
    const df = byPos('DEF');
    const md = byPos('MID');
    const fw = byPos('FWD');

    const xi = [...gk.slice(0, 1), ...df.slice(0, 3), ...md.slice(0, 4), ...fw.slice(0, 3)];
    const bench = [...gk.slice(1), ...df.slice(3), ...md.slice(4), ...fw.slice(3)];
    const ordered = [...xi, ...bench];

    onSubmit({
      playerIds: ordered.map((p) => p.id),
      captainId: xi.reduce((best, p) => (p.points > best.points ? p : best), xi[0]).id,
      viceCaptainId:
        [...xi].sort((a, b) => b.points - a.points)[1]?.id ?? xi[0].id,
    });
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="panel overflow-hidden"
    >
      <div className="flex flex-col gap-1.5 border-b border-line px-5 py-5 sm:px-6">
        <span className="eyebrow">
          {gameweek ? `Enter your GW${gameweek} squad` : 'Enter your squad'}
        </span>
        <p className="max-w-2xl text-sm leading-relaxed text-muted">{reason}</p>
      </div>

      {/* Budget and shape, always visible while picking. */}
      <div className="grid grid-cols-2 divide-x divide-y divide-line sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
        <div className="flex flex-col gap-1 px-4 py-3">
          <span className="eyebrow">Selected</span>
          <span className={`nums text-lg font-bold ${complete ? 'text-accent' : 'text-text'}`}>
            {selected.length}/15
          </span>
        </div>
        <div className="flex flex-col gap-1 px-4 py-3">
          <span className="eyebrow">Remaining</span>
          <span
            className={`nums text-lg font-bold ${remaining < 0 ? 'text-rose' : 'text-text'}`}
          >
            £{remaining.toFixed(1)}m
          </span>
        </div>
        {POSITIONS.map((pos) => (
          <div key={pos} className="flex flex-col gap-1 px-4 py-3">
            <span className="eyebrow">{pos}</span>
            <span
              className={`nums text-lg font-bold ${
                counts[pos] === SHAPE[pos] ? 'text-accent' : 'text-muted'
              }`}
            >
              {counts[pos]}/{SHAPE[pos]}
            </span>
          </div>
        ))}
      </div>

      {/* Chosen players. */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-line px-5 py-4 sm:px-6">
          <AnimatePresence mode="popLayout">
            {POSITIONS.flatMap((pos) => selected.filter((p) => p.pos === pos)).map((p) => (
              <motion.button
                key={p.id}
                layout
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                type="button"
                onClick={() => toggle(p)}
                title="Remove"
                className="group flex items-center gap-1.5 rounded-md border border-line-bright bg-white/[0.04] px-2 py-1 text-xs transition-colors hover:border-rose/50 hover:bg-rose/[0.08]"
              >
                <span className="text-[9px] font-bold uppercase text-faint">{p.pos}</span>
                <span className="font-semibold">{p.name}</span>
                <span className="nums text-[10px] text-faint">£{p.price.toFixed(1)}</span>
                <span className="text-faint transition-colors group-hover:text-rose">×</span>
              </motion.button>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Picker. */}
      <div className="flex flex-col gap-3 border-t border-line px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-line p-0.5">
            {POSITIONS.map((pos) => (
              <button
                key={pos}
                type="button"
                onClick={() => setTab(pos)}
                className={`rounded-md px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors ${
                  tab === pos ? 'bg-white/[0.08] text-text' : 'text-faint hover:text-muted'
                }`}
              >
                {pos}
                <span className="ml-1.5 text-[10px] opacity-60">
                  {counts[pos]}/{SHAPE[pos]}
                </span>
              </button>
            ))}
          </div>

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or club…"
            className="min-w-[180px] flex-1 rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint focus:border-accent/40"
          />

          <div className="flex rounded-lg border border-line p-0.5">
            {(['points', 'form', 'price'] as SortKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setSort(key)}
                className={`rounded-md px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                  sort === key ? 'bg-white/[0.08] text-text' : 'text-faint hover:text-muted'
                }`}
              >
                {key}
              </button>
            ))}
          </div>
        </div>

        {loadError && <p className="text-sm text-rose">{loadError}</p>}
        {!players && !loadError && <p className="py-8 text-center text-sm text-muted">Loading players…</p>}

        {players && (
          <div className="max-h-[380px] overflow-y-auto rounded-lg border border-line">
            {visible.length === 0 && (
              <p className="py-8 text-center text-sm text-faint">No players match that search.</p>
            )}
            {visible.map((p) => {
              const isSelected = selected.some((s) => s.id === p.id);
              const posFull = counts[p.pos] >= SHAPE[p.pos];
              const clubFull = (clubCounts.get(p.team) ?? 0) >= MAX_PER_CLUB;
              const tooDear = !isSelected && p.price > remaining + 0.001;
              const blocked = !isSelected && (posFull || clubFull);

              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggle(p)}
                  disabled={blocked}
                  title={
                    clubFull && !isSelected
                      ? `Already have ${MAX_PER_CLUB} ${p.team} players`
                      : posFull && !isSelected
                        ? `Already have ${SHAPE[p.pos]} ${p.pos} players`
                        : (p.flag ?? undefined)
                  }
                  className={`flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left transition-colors last:border-b-0 ${
                    isSelected
                      ? 'bg-accent/[0.08]'
                      : blocked
                        ? 'cursor-not-allowed opacity-35'
                        : 'hover:bg-white/[0.03]'
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                      isSelected ? 'border-accent bg-accent text-void' : 'border-line-bright'
                    }`}
                  >
                    {isSelected ? '✓' : ''}
                  </span>

                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {p.name}
                    {p.flag && <span className="ml-1.5 text-rose" title={p.flag}>●</span>}
                  </span>

                  <span className="nums w-10 shrink-0 text-[11px] text-faint">{p.team}</span>
                  <span className="nums w-12 shrink-0 text-right text-[11px] text-muted">
                    {p.points}pts
                  </span>
                  <span
                    className={`nums w-14 shrink-0 text-right text-xs font-bold ${
                      tooDear ? 'text-rose' : 'text-text'
                    }`}
                  >
                    £{p.price.toFixed(1)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {error && (
        <p className="border-t border-line px-5 py-3 text-sm text-rose sm:px-6">{error}</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4 sm:px-6">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs font-semibold text-faint transition-colors hover:text-muted"
        >
          Use a different manager ID
        </button>

        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="rounded-xl bg-accent px-6 py-3 text-sm font-bold uppercase tracking-wider text-void transition-opacity disabled:opacity-25"
        >
          {busy
            ? 'Loading squad…'
            : remaining < 0
              ? `Over budget by £${Math.abs(remaining).toFixed(1)}m`
              : complete
                ? 'Save squad'
                : `Pick ${15 - selected.length} more`}
        </button>
      </div>
    </motion.section>
  );
}
