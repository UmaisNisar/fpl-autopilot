'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ManualSquad, SquadPlayer, TeamSnapshot } from '@/lib/fpl/model';
import type { PlanResult } from '@/lib/gemini/plan';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AnalyzeButton } from './AnalyzeButton';
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
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY) ?? defaultManagerId ?? '';
    const parsed = Number(stored);
    if (Number.isInteger(parsed) && parsed > 0) setManagerId(parsed);
    setReady(true);
  }, [defaultManagerId]);

  const loadTeam = useCallback(async (id: number, squad?: ManualSquad | null) => {
    setLoading(true);
    setLoadError(null);
    setResult(null);
    setAnalyseError(null);

    try {
      // A stored manual squad is posted; otherwise ask the API for the real one.
      const res = squad
        ? await fetch('/api/team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ managerId: id, squad }),
          })
        : await fetch(`/api/team?managerId=${id}`);

      if (!res.ok) {
        const { error, needsManualSquad } = await readError(res, 'Could not load that team.');
        setSnapshot(null);
        setNeedsSquad(Boolean(needsManualSquad));
        setLoadError(error ?? null);
        // Remember the ID anyway -- it is valid, just not readable yet.
        if (needsManualSquad) window.localStorage.setItem(STORAGE_KEY, String(id));
        return;
      }

      setSnapshot((await res.json()) as TeamSnapshot);
      setNeedsSquad(false);
      setLoadError(null);
      window.localStorage.setItem(STORAGE_KEY, String(id));
    } catch {
      setLoadError('Could not reach the server.');
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (managerId === null) return;
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
          {snapshot?.manualSquad && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setNeedsSquad(true);
                setSnapshot(null);
                setResult(null);
              }}
              className="border-line text-dim hover:border-brand/40 hover:text-brand"
            >
              Edit squad
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

      {needsSquad && !snapshot && (
        <SquadBuilder
          reason={
            loadError ??
            'Re-enter your fifteen. This replaces the squad saved on this device.'
          }
          busy={loading}
          onSubmit={saveSquad}
          onCancel={reset}
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
              <span className="eyebrow px-1">
                {result ? 'Recommended lineup' : 'Your squad'}
              </span>
              <Pitch state={pitchState} />
            </motion.div>
          )}

          <AnalyzeButton onClick={analyse} busy={analysing} hasResult={result !== null} />
        </>
      )}
    </main>
  );
}
