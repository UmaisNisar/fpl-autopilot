import { NextResponse } from 'next/server';

import { FplError, getBootstrap } from '@/lib/fpl/client';
import type { PositionShort } from '@/lib/fpl/types';

export const dynamic = 'force-dynamic';

/** The minimum a squad picker needs. Kept small -- this ships ~700 rows. */
export interface PlayerOption {
  id: number;
  name: string;
  team: string;
  teamCode: number;
  pos: PositionShort;
  price: number;
  points: number;
  form: number;
  /** Percentage of managers who own the player. */
  owned: number;
  /** Present only when there is an availability concern. */
  flag?: string;
}

const POSITIONS: PositionShort[] = ['GKP', 'DEF', 'MID', 'FWD'];

/** GET /api/players -- every selectable player, for manual squad entry. */
export async function GET() {
  try {
    const bootstrap = await getBootstrap();
    const teams = new Map(bootstrap.teams.map((t) => [t.id, t]));

    const players: PlayerOption[] = bootstrap.elements
      // Players removed from the game cannot be picked.
      .filter((el) => el.status !== 'u' || el.minutes > 0)
      .map((el) => {
        const team = teams.get(el.team);
        const option: PlayerOption = {
          id: el.id,
          name: el.web_name,
          team: team?.short_name ?? 'TBC',
          teamCode: el.team_code,
          pos: POSITIONS[el.element_type - 1] ?? 'MID',
          price: el.now_cost / 10,
          points: el.total_points,
          form: parseFloat(el.form) || 0,
          owned: parseFloat(el.selected_by_percent) || 0,
        };
        if (el.status !== 'a') option.flag = el.news || 'Availability doubt';
        return option;
      })
      .sort((a, b) => b.points - a.points || b.form - a.form);

    return NextResponse.json({ players });
  } catch (error) {
    if (error instanceof FplError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[api/players]', error);
    return NextResponse.json({ error: 'Could not load the player list.' }, { status: 500 });
  }
}
