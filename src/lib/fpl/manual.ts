import type { ManualSquad } from './model';

export const SQUAD_SIZE = 15;

/**
 * Accept a manually entered squad only if it is structurally sound: fifteen
 * distinct player ids, with captain and vice drawn from those ids.
 *
 * Position counts, budget and the club limit are checked against live player
 * data when the snapshot is built -- this is only the shape gate.
 */
export function parseManualSquad(value: unknown): ManualSquad | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;

  const ids = Array.isArray(input.playerIds)
    ? input.playerIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];

  if (ids.length !== SQUAD_SIZE || new Set(ids).size !== SQUAD_SIZE) return null;

  const asId = (v: unknown) => {
    const n = Number(v);
    return Number.isInteger(n) && ids.includes(n) ? n : null;
  };

  const bank = Number(input.bank);
  const freeTransfers = Number(input.freeTransfers);
  const forEvent = Number(input.forEvent);

  return {
    playerIds: ids,
    captainId: asId(input.captainId),
    viceCaptainId: asId(input.viceCaptainId),
    bank: Number.isFinite(bank) && bank >= 0 ? Math.round(bank * 10) / 10 : undefined,
    freeTransfers:
      Number.isInteger(freeTransfers) && freeTransfers >= 0 && freeTransfers <= 5
        ? freeTransfers
        : undefined,
    forEvent: Number.isInteger(forEvent) && forEvent > 0 ? forEvent : undefined,
  };
}

/**
 * Manager ids this deployment will serve.
 *
 * Set ALLOWED_MANAGER_IDS to lock a public deployment to one team, so a stray
 * visitor cannot spend the owner's Gemini quota looking up other people's
 * squads. Unset means unrestricted, which is what local development wants.
 */
export function isManagerAllowed(managerId: number): boolean {
  const allowed = process.env.ALLOWED_MANAGER_IDS?.trim();
  if (!allowed) return true;
  return allowed
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0)
    .includes(managerId);
}
