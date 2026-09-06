'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ManualSquad, SquadPlayer, TeamSnapshot } from '@/lib/fpl/model';
import type { PlanResult } from '@/lib/gemini/plan';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AnalyzeButton } from './AnalyzeButton';
import { ApplyPlan } from './ApplyPlan';
import { EngineBreakdown } from './EngineBreakdown';
import { ManagerGate } from './ManagerGate';
import { Pitch, type PitchState } from './Pitch';
import { PlanView } from './PlanView';
import { SquadBuilder } from './SquadBuilder';
import { StatusRail } from './StatusRail';

const STORAGE_KEY = 'fpl-autopilot:manager-id';
const SQUAD_KEY = 'fpl-autopilot:manual-squad';

interface Props {
  defaultManagerId?: string;
  /** Comma-separated player ids, used when no squad is saved on this device. */
  defaultSquad?: string;
  /** Money in the bank, in millions, to pair with `defaultSquad`. */
  defaultBank?: string;
}

interface ApiError {
  error?: string;
  needsManualSquad?: boolean;
}

async function readError(res: Response, fallback: string): Promise<ApiError> {
  try {
    const body = (await res.json()) as ApiError;
    return { error: body.error || fallback, needsManualSquad: body.needsManualSquad };
  } catch {
    return { error: fallback };
  }
}

function loadStoredSquad(managerId: number): ManualSquad | null {
  try {
    const raw = window.localStorage.getItem(`${SQUAD_KEY}:${managerId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ManualSquad;
    return Array.isArray(parsed?.playerIds) && parsed.playerIds.length === 15 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A hand-entered squad describes one gameweek and expires with it.
 *
 * Once that deadline passes the API knows the real team, so keeping the
 * correction would show a squad that has since changed -- which is exactly how
 * a pinned GW3 team ended up on screen during GW4.
 */
function isCurrent(squad: ManualSquad | null, event: number | null): boolean {
  if (!squad) return false;
  if (squad.forEvent === undefined) return true;
  return event === null || squad.forEvent >= event;
}

/**
 * A squad supplied by configuration, for the case the public API cannot cover:
 * before the first deadline it will not reveal the team, so the fifteen can be
 * pinned here instead of retyped on every device.
 */
function parseConfiguredSquad(
  value: string | undefined,
  bank: string | undefined,
): ManualSquad | null {
  if (!value) return null;
  const playerIds = value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (playerIds.length !== 15 || new Set(playerIds).size !== 15) return null;

  const parsedBank = Number(bank);
  return {
    playerIds,
    captainId: null,
    viceCaptainId: null,
    bank: Number.isFinite(parsedBank) && parsedBank >= 0 ? parsedBank : undefined,
  };
}

/**
 * How long ago the squad was read from FPL.
 *
 * Worth showing next to the refresh control: the squad on screen is only as
 * current as the last fetch, and a transfer made since then will not appear
 * until it is reloaded.
 */
function FetchedAt({ iso }: { iso: string }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const render = () => {
      const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
      if (seconds < 60) setLabel('just now');
      else if (seconds < 3600) setLabel(`${Math.floor(seconds / 60)}m ago`);
      else setLabel(`${Math.floor(seconds / 3600)}h ago`);
    };
    render();
    const id = setInterval(render, 30_000);
    return () => clearInterval(id);
  }, [iso]);

  // Rendered only after mount, so the server and client markup agree.
  return label ? <span className="text-[10px] text-faint">updated {label}</span> : null;
}

/** Local formation label so the pre-analysis pitch matches the plan's format. */
function formationOf(xi: SquadPlayer[]): string {
  const count = (pos: string) => xi.filter((p) => p.position === pos).length;
  return `${count('DEF')}-${count('MID')}-${count('FWD')}`;
}

export function Dashboard({ defaultManagerId, defaultSquad, defaultBank }: Props) {
  const [managerId, setManagerId] = useState<number | null>(null);
  const [ready, setReady] = useState(false);

  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [manualSquad, setManualSquad] = useState<ManualSquad | null>(null);
  const [needsSquad, setNeedsSquad] = useState(false);

  const [result, setResult] = useState<PlanResult | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [analyseError, setAnalyseError] = useState<string | null>(null);

  const planRef = useRef<HTMLDivElement>(null);

  // Remember the manager ID so the app opens straight onto the squad.
  // localStorage is a browser API, not React state, so reading it on mount is
  // the intended use of an effect even though it does call setState.
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY) ?? defaultManagerId ?? '';
    const parsed = Number(stored);
    if (Number.isInteger(parsed) && parsed > 0) setManagerId(parsed);
    setReady(true);
  }, [defaultManagerId]);

  /**
   * Load the squad, preferring the live API over anything typed in.
   *
   * A manually entered squad is a stand-in for one specific situation: the API
   * hides a team until that manager's first deadline has passed. The moment it
   * will serve the real thing, that is the truth -- so the API is always asked
   * first, and the manual squad is used only when it answers NO_SQUAD.
   *
   * Getting this precedence wrong left the app showing a stale hand-typed team
   * long after the real one became available.
   */
  const loadTeam = useCallback(
    async (id: number, fallbackSquad?: ManualSquad | null, force = false) => {
    setLoading(true);
    setLoadError(null);
    setResult(null);
    setAnalyseError(null);

    const applySnapshot = (snapshotData: TeamSnapshot) => {
      setSnapshot(snapshotData);
      setNeedsSquad(false);
      setLoadError(null);
      window.localStorage.setItem(STORAGE_KEY, String(id));
    };

    try {
      const live = await fetch(`/api/team?managerId=${id}${force ? '&refresh=1' : ''}`);

      if (live.ok) {
        const snapshotData = (await live.json()) as TeamSnapshot;

        // The API only ever knows the team as of the last deadline. A
        // correction made for the gameweek now being planned is more current,
        // so it wins; an older one has been overtaken and is discarded.
        if (fallbackSquad && isCurrent(fallbackSquad, snapshotData.gameweek.id)) {
          const corrected = await fetch('/api/team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ managerId: id, squad: fallbackSquad }),
          });
          if (corrected.ok) {
            setManualSquad(fallbackSquad);
            applySnapshot((await corrected.json()) as TeamSnapshot);
            return;
          }
        }

        window.localStorage.removeItem(`${SQUAD_KEY}:${id}`);
        setManualSquad(null);
        applySnapshot(snapshotData);
        return;
      }

      const { error, needsManualSquad } = await readError(live, 'Could not load that team.');

      if (!needsManualSquad) {
        setSnapshot(null);
        setNeedsSquad(false);
        setLoadError(error ?? null);
        return;
      }

      // The API cannot expose this squad yet. Fall back to the entered one.
      window.localStorage.setItem(STORAGE_KEY, String(id));

      if (!fallbackSquad) {
        setSnapshot(null);
        setNeedsSquad(true);
        setLoadError(error ?? null);
        return;
      }

      const manual = await fetch('/api/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ managerId: id, squad: fallbackSquad }),
      });

      if (!manual.ok) {
        const manualError = await readError(manual, 'Could not load that squad.');
        setSnapshot(null);
        setNeedsSquad(true);
        setLoadError(manualError.error ?? null);
        return;
      }

      setManualSquad(fallbackSquad);
      applySnapshot((await manual.json()) as TeamSnapshot);
    } catch {
      setLoadError('Could not reach the server.');
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  },
    [],
  );

  const [refreshing, setRefreshing] = useState(false);

  /** Pull the squad again from the FPL API, ignoring anything cached. */
  const refresh = useCallback(async () => {
    if (managerId === null || refreshing) return;
    setRefreshing(true);
    try {
      await loadTeam(managerId, manualSquad, true);
    } finally {
      setRefreshing(false);
    }
  }, [managerId, manualSquad, loadTeam, refreshing]);

  useEffect(() => {
    if (managerId === null) return;
    // Seeding from storage is exactly what an effect is for: the value lives
    // in the browser, so it cannot be derived during render.
    const squad = loadStoredSquad(managerId) ?? parseConfiguredSquad(defaultSquad, defaultBank);
    setManualSquad(squad);
    void loadTeam(managerId, squad);
  }, [managerId, loadTeam, defaultSquad, defaultBank]);

  const saveSquad = useCallback(
    (squad: ManualSquad) => {
      if (managerId === null) return;
      window.localStorage.setItem(`${SQUAD_KEY}:${managerId}`, JSON.stringify(squad));
      setManualSquad(squad);
      void loadTeam(managerId, squad);
    },
    [managerId, loadTeam],
  );

  const analyse = useCallback(async () => {
    if (managerId === null || analysing) return;
    setAnalysing(true);
    setAnalyseError(null);

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ managerId, squad: manualSquad ?? undefined }),
      });

      if (!res.ok) {
        const { error, needsManualSquad } = await readError(res, 'Analysis failed.');
        setAnalyseError(error ?? null);
        // The squad we held is no longer usable -- go back to the builder.
        if (needsManualSquad) setNeedsSquad(true);
        return;
      }

      const payload = (await res.json()) as PlanResult & { snapshot: TeamSnapshot };
      setSnapshot(payload.snapshot);
      setResult(payload);

      // Bring the answer into view -- it is the point of the page.
      requestAnimationFrame(() =>
        planRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
    } catch {
      setAnalyseError('Could not reach the server.');
    } finally {
      setAnalysing(false);
    }
  }, [managerId, analysing, manualSquad]);

  // The pitch shows the current team until a plan exists, then the plan.
  const pitchState = useMemo<PitchState | null>(() => {
    if (result) {
      return {
        startingXi: result.resolved.startingXi,
        bench: result.resolved.bench,
        captainId: result.resolved.captainId,
        viceCaptainId: result.resolved.viceCaptainId,
        formation: result.plan.formation,
        incomingIds: result.resolved.in.map((p) => p.id),
        outgoing: result.resolved.out,
        metrics: result.engine?.playerMetrics,
      };
    }
    if (!snapshot) return null;

    const startingXi = snapshot.squad.filter((p) => p.isStarter);
    return {
      startingXi,
      bench: snapshot.squad.filter((p) => !p.isStarter),
      captainId: snapshot.squad.find((p) => p.isCaptain)?.id ?? null,
      viceCaptainId: snapshot.squad.find((p) => p.isViceCaptain)?.id ?? null,
      formation: formationOf(startingXi),
    };
  }, [result, snapshot]);

  const reset = () => {
    if (managerId !== null) window.localStorage.removeItem(`${SQUAD_KEY}:${managerId}`);
    window.localStorage.removeItem(STORAGE_KEY);
    setManagerId(null);
    setSnapshot(null);
    setResult(null);
    setManualSquad(null);
    setNeedsSquad(false);
    setLoadError(null);
  };

  if (!ready) return null;

  if (managerId === null) {
    return (
      <main className="mx-auto w-full max-w-5xl px-5 py-10">
        <ManagerGate onSubmit={setManagerId} error={loadError} busy={loading} />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-brand/30 bg-brand/[0.08] text-brand">
            ⚡
          </span>
          <div className="flex flex-col">
            <h1 className="text-lg font-extrabold uppercase tracking-[0.18em]">
              FPL Autopilot
            </h1>
            {snapshot && (
              <span className="text-xs text-dim">
                {snapshot.manager.teamName} · {snapshot.manager.name}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {snapshot && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setNeedsSquad(true);
                setResult(null);
              }}
              className="border-line text-dim hover:border-brand/40 hover:text-brand"
            >
              {snapshot.squadSource === 'entered' ? 'Edit squad' : 'Update squad'}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={reset}
            className="nums border-line text-dim hover:border-line-bright hover:text-text"
          >
            ID {managerId}
          </Button>
        </div>
      </header>

      {loading && !snapshot && (
        <div className="flex flex-col gap-6" aria-busy aria-label="Loading your squad">
          <Skeleton className="h-[168px] w-full rounded-[14px] bg-white/[0.03]" />
          <Skeleton className="h-[420px] w-full rounded-[14px] bg-white/[0.03]" />
          <Skeleton className="h-[104px] w-full rounded-2xl bg-white/[0.03]" />
        </div>
      )}

      {needsSquad && (
        <SquadBuilder
          gameweek={snapshot?.gameweek.id}
          reason={
            loadError ??
            'FPL does not publish transfers made for a gameweek that has not kicked off, so the squad above is your team as it stood at the last deadline. Correct it here and the analysis will use it.'
          }
          busy={loading}
          initialSquad={
            snapshot
              ? {
                  playerIds: snapshot.squad.map((p) => p.id),
                  bank: snapshot.finances.bank,
                  freeTransfers: snapshot.finances.freeTransfers,
                }
              : null
          }
          onSubmit={saveSquad}
          onCancel={() => (snapshot ? setNeedsSquad(false) : reset())}
        />
      )}

      {loadError && !snapshot && !needsSquad && (
        <div className="panel flex flex-col items-center gap-4 px-6 py-16 text-center">
          <p className="text-sm text-rose">{loadError}</p>
          <Button variant="outline" size="sm" onClick={reset} className="border-line text-dim">
            Use a different manager ID
          </Button>
        </div>
      )}

      {snapshot && (
        <>
          <StatusRail snapshot={snapshot} />

          {/*
            Once a plan exists it takes the top slot -- the answer is the point
            of the page, and the pitch below becomes the picture of that answer.
          */}
          <div ref={planRef} className="flex scroll-mt-6 flex-col gap-6">
            <AnimatePresence mode="wait">
              {result && <PlanView key={result.meta.generatedAt} result={result} />}
            </AnimatePresence>
            {result && <ApplyPlan result={result} snapshot={snapshot} />}
            {result?.engine && (
              <EngineBreakdown
                key={`${result.meta.generatedAt}-engine`}
                engine={result.engine}
                chosenMoves={result.plan.transfer.moves.map((m) => ({ out: m.out, in: m.in }))}
                captain={result.plan.captain}
              />
            )}
          </div>

          {analyseError && (
            <div className="rounded-lg border border-rose/30 bg-rose/[0.05] px-4 py-3 text-sm text-rose">
              {analyseError}
            </div>
          )}

          {pitchState && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col gap-2"
            >
              <div className="flex items-center justify-between gap-3 px-1">
                <span className="eyebrow">
                  {result ? 'Recommended lineup' : 'Your squad'}
                </span>

                <div className="flex items-center gap-2">
                  {snapshot && <FetchedAt iso={snapshot.fetchedAt} />}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={refresh}
                        disabled={refreshing || loading}
                        aria-label="Reload squad from FPL"
                        className="text-faint hover:text-brand"
                      >
                        <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Reload from FPL — use this after making a transfer
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <Pitch state={pitchState} />
            </motion.div>
          )}

          <AnalyzeButton onClick={analyse} busy={analysing} hasResult={result !== null} />
        </>
      )}
    </main>
  );
}
