import { NextResponse } from 'next/server';

import { FplError } from '@/lib/fpl/client';
import { buildTeamSnapshot } from '@/lib/fpl/service';
import { buildAnalysisContext } from '@/lib/analysis/dataset';
import { GeminiError, getModelName, hasApiKey, requestPlan } from '@/lib/gemini/client';
import { isMockEnabled, mockPlanResponse } from '@/lib/gemini/mock';
import { buildEnginePlan, parsePlanJson, validatePlan } from '@/lib/gemini/validate';
import type { PlanResult } from '@/lib/gemini/plan';
import { isManagerAllowed, parseManualSquad } from '@/lib/fpl/manual';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** POST /api/analyze  { managerId } -- the one button. */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const managerId = Number(body.managerId);
  if (!Number.isInteger(managerId) || managerId <= 0) {
    return NextResponse.json({ error: 'A valid manager ID is required.' }, { status: 400 });
  }

  if (!isManagerAllowed(managerId)) {
    return NextResponse.json(
      { error: 'This deployment is locked to a different FPL team.' },
      { status: 403 },
    );
  }

  // A manually entered squad is used when the API cannot expose the real one.
  const manualSquad = body.squad ? parseManualSquad(body.squad) : null;

  try {
    const snapshot = await buildTeamSnapshot(managerId, manualSquad ?? undefined);
    const { dataset, candidates, engine } = await buildAnalysisContext(snapshot);

    if (!hasApiKey() && !isMockEnabled()) {
      return NextResponse.json(
        {
          error:
            'No Gemini API key configured. Add GEMINI_API_KEY to .env.local and restart the dev server.',
        },
        { status: 503 },
      );
    }

    let validated;
    let fallback = false;

    try {
      const text = isMockEnabled()
        ? mockPlanResponse(dataset)
        : (await requestPlan(dataset)).text;
      const parsed = parsePlanJson(text);

      if (!parsed) {
        validated = buildEnginePlan(
          snapshot,
          engine,
          candidates,
          'Gemini returned a response that could not be read.',
        );
        fallback = true;
      } else {
        validated = validatePlan(parsed, {
          snapshot,
          candidates,
          engine: {
            recommendation: {
              moves: engine.recommendation.moves.map((m) => ({
                outId: m.outId,
                inId: m.inId,
              })),
              captainId: engine.recommendation.captainId,
            },
            options: engine.transfers.ranked.map((o) => ({
              moves: o.moves.map((m) => ({ outId: m.outId, inId: m.inId })),
              net: o.net,
            })),
          },
        });
      }
    } catch (error) {
      // A model failure must never take the app down -- fall back to the local
      // optimiser and say so plainly.
      const reason =
        error instanceof GeminiError
          ? `Gemini was unavailable (${error.message})`
          : 'Gemini was unavailable.';
      console.error('[api/analyze] gemini', error);
      validated = buildEnginePlan(snapshot, engine, candidates, reason);
      fallback = true;
    }

    const result: PlanResult & { snapshot: typeof snapshot } = {
      snapshot,
      plan: validated.plan,
      resolved: validated.resolved,
      finalSquad: validated.finalSquad,
      warnings: validated.warnings,
      fallback,
      meta: {
        gameweek: snapshot.gameweek.id,
        model: isMockEnabled() ? 'mock (no API key)' : getModelName(),
        generatedAt: new Date().toISOString(),
      },
    };

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FplError) {
      return NextResponse.json(
        { error: error.message, code: error.code, needsManualSquad: error.code === 'NO_SQUAD' },
        { status: error.status },
      );
    }
    console.error('[api/analyze]', error);
    return NextResponse.json({ error: 'Analysis failed. Try again.' }, { status: 500 });
  }
}
