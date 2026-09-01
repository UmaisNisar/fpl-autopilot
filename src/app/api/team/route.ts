import { NextResponse } from 'next/server';

import { FplError } from '@/lib/fpl/client';
import { buildTeamSnapshot } from '@/lib/fpl/service';
import { isManagerAllowed, parseManualSquad } from '@/lib/fpl/manual';

export const dynamic = 'force-dynamic';

function parseManagerId(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function errorResponse(error: unknown, managerId: number) {
  if (error instanceof FplError) {
    const message =
      error.status === 404 ? `No FPL team found for manager ID ${managerId}.` : error.message;
    // NO_SQUAD is expected for a manager whose first gameweek has not started;
    // the client uses this flag to offer manual squad entry instead.
    return NextResponse.json(
      { error: message, code: error.code, needsManualSquad: error.code === 'NO_SQUAD' },
      { status: error.status },
    );
  }
  console.error('[api/team]', error);
  return NextResponse.json({ error: 'Something went wrong loading your team.' }, { status: 500 });
}

/** GET /api/team?managerId=1234567 -- the squad the API already knows about. */
export async function GET(request: Request) {
  const managerId = parseManagerId(new URL(request.url).searchParams.get('managerId'));

  if (managerId === null) {
    return NextResponse.json(
      { error: 'Enter a valid FPL manager ID (the number in your team URL).' },
      { status: 400 },
    );
  }

  if (!isManagerAllowed(managerId)) {
    return NextResponse.json(
      { error: 'This deployment is locked to a different FPL team.' },
      { status: 403 },
    );
  }

  try {
    return NextResponse.json(await buildTeamSnapshot(managerId));
  } catch (error) {
    return errorResponse(error, managerId);
  }
}

/**
 * POST /api/team  { managerId, squad }
 *
 * Same snapshot, built from a squad the manager typed in. Needed before their
 * first deadline, when the public API will not reveal their team.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const managerId = parseManagerId(body.managerId);
  if (managerId === null) {
    return NextResponse.json({ error: 'A valid manager ID is required.' }, { status: 400 });
  }

  if (!isManagerAllowed(managerId)) {
    return NextResponse.json(
      { error: 'This deployment is locked to a different FPL team.' },
      { status: 403 },
    );
  }

  const squad = parseManualSquad(body.squad);
  if (!squad) {
    return NextResponse.json(
      { error: 'A squad must be exactly 15 distinct players.' },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await buildTeamSnapshot(managerId, squad));
  } catch (error) {
    return errorResponse(error, managerId);
  }
}
