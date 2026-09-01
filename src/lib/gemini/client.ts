import 'server-only';

import { SYSTEM_INSTRUCTION, buildUserPrompt } from './prompt';
import type { AnalysisDataset } from '@/lib/analysis/dataset';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

/**
 * Gemini's structured-output schema (an OpenAPI subset). Forcing the shape here
 * means the validator downstream is checking semantics, not JSON syntax.
 */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transfer_decision: {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', enum: ['hold', 'transfer'] },
        moves: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              out: { type: 'STRING' },
              in: { type: 'STRING' },
              reason: { type: 'STRING' },
            },
            required: ['out', 'in', 'reason'],
          },
        },
        take_hit: { type: 'BOOLEAN' },
        hit_cost: { type: 'INTEGER' },
      },
      required: ['action', 'moves', 'take_hit', 'hit_cost'],
    },
    captain: { type: 'STRING' },
    vice_captain: { type: 'STRING' },
    formation: { type: 'STRING' },
    starting_xi: { type: 'ARRAY', items: { type: 'STRING' } },
    bench_order: { type: 'ARRAY', items: { type: 'STRING' } },
    chip: {
      type: 'STRING',
      enum: ['none', 'wildcard', 'freehit', 'bboost', '3xc'],
    },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
    summary: { type: 'STRING' },
  },
  required: [
    'transfer_decision',
    'captain',
    'vice_captain',
    'formation',
    'starting_xi',
    'bench_order',
    'chip',
    'confidence',
    'summary',
  ],
  propertyOrdering: [
    'transfer_decision',
    'captain',
    'vice_captain',
    'formation',
    'starting_xi',
    'bench_order',
    'chip',
    'confidence',
    'summary',
  ],
} as const;

export function getModelName(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

export function hasApiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

/** Ask Gemini for a plan. Returns the raw JSON text; parsing happens in the validator. */
export async function requestPlan(dataset: AnalysisDataset): Promise<{ text: string; model: string }> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new GeminiError(
      'GEMINI_API_KEY is not set. Add it to .env.local and restart the dev server.',
      500,
    );
  }

  const model = getModelName();
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: buildUserPrompt(dataset) }] }],
    generationConfig: {
      // Low but non-zero: we want a decisive answer, not a creative one.
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      // Generous: on 2.5 models reasoning tokens are drawn from this same
      // budget, and a plan that runs out mid-object comes back empty.
      maxOutputTokens: 16384,
    },
  };

  const res = await fetchWithRetry(
    `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      cache: 'no-store',
    },
  );

  const json = (await res.json()) as GeminiResponse;

  if (!res.ok) {
    const detail = json.error?.message ?? `HTTP ${res.status}`;
    throw new GeminiError(`Gemini rejected the request: ${detail}`, res.status);
  }

  if (json.promptFeedback?.blockReason) {
    throw new GeminiError(`Gemini blocked the prompt (${json.promptFeedback.blockReason}).`, 502);
  }

  const candidate = json.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

  if (!text.trim()) {
    const reason = candidate?.finishReason ?? 'empty response';
    const detail =
      reason === 'MAX_TOKENS'
        ? 'the model hit its output limit before finishing the plan'
        : reason === 'SAFETY' || reason === 'RECITATION'
          ? `the response was filtered (${reason})`
          : reason;
    throw new GeminiError(`Gemini returned no usable content: ${detail}.`, 502);
  }

  return { text, model };
}

/** One retry on transient failures; anything else surfaces immediately. */
async function fetchWithRetry(url: string, init: RequestInit, attempt = 0): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (cause) {
    if (attempt < 1) return fetchWithRetry(url, init, attempt + 1);
    throw new GeminiError('Could not reach the Gemini API.', 503);
  }

  const transient = res.status === 429 || res.status === 503 || res.status >= 500;
  if (transient && attempt < 1) {
    await new Promise((r) => setTimeout(r, 900));
    return fetchWithRetry(url, init, attempt + 1);
  }
  return res;
}
