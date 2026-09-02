import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/* =============================================================================
   Speech to text via Groq (whisper-large-v3-turbo).
   -----------------------------------------------------------------------------
   The audio is forwarded straight to Groq and never written to disk, a
   database or a log. Only the transcript comes back, and even that is not
   stored — the client parses it, shows a confirmation, and discards it.

   The key lives only in this server function. If it is missing, the endpoint
   says so plainly and the client falls back to the browser's own speech
   engine, so a demo never dies because of a missing key or a rate limit.
   ========================================================================== */

const MODEL = 'whisper-large-v3-turbo';
const MAX_BYTES = 8 * 1024 * 1024; // ~2 minutes of compressed speech

/**
 * Words the model has no reason to guess correctly on its own. Feeding them as
 * context measurably improves accuracy on belt sizes and brand names spoken in
 * an Indian accent over a noisy shop floor.
 */
const PROMPT =
  'Industrial belt stock entry. Terms: timing belt, V-belt, inward, outward, ' +
  'meter, piece, Optibelt, Gates, Fenner, Bando, Mitsuboshi, ContiTech, ' +
  'Megadyne, Dunlop, Dongil, HTD, STD, RPP, AT10, AT5, T10, T5, SPZ, SPA, SPB, SPC.';

// Small in-memory guard against a stuck mic hammering the free tier. Serverless
// instances are short-lived, so this is a speed bump, not a real quota.
const recent = new Map<string, number[]>();
const WINDOW = 60_000;
const LIMIT = 20;

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const hits = (recent.get(userId) ?? []).filter((t) => now - t < WINDOW);
  hits.push(now);
  recent.set(userId, hits);
  if (recent.size > 500) recent.clear();
  return hits.length > LIMIT;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });

  if (!session.permissions.includes('transactions.create')) {
    return NextResponse.json({ error: 'Your role does not allow recording stock.' }, { status: 403 });
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: 'Voice transcription is not configured.', fallback: true },
      { status: 503 },
    );
  }

  if (rateLimited(session.user.id)) {
    return NextResponse.json(
      { error: 'Too many voice requests. Wait a moment.', fallback: true },
      { status: 429 },
    );
  }

  let audio: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get('audio');
    if (value instanceof File) audio = value;
  } catch {
    return NextResponse.json({ error: 'Could not read the recording.' }, { status: 400 });
  }

  if (!audio || audio.size === 0) {
    return NextResponse.json({ error: 'No audio was recorded.' }, { status: 400 });
  }
  if (audio.size > MAX_BYTES) {
    return NextResponse.json({ error: 'That recording is too long. Keep it under a minute.' }, { status: 413 });
  }

  const upstream = new FormData();
  upstream.append('file', audio, 'speech.webm');
  upstream.append('model', MODEL);
  upstream.append('language', 'en');
  upstream.append('temperature', '0');
  upstream.append('response_format', 'json');
  upstream.append('prompt', PROMPT);

  try {
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: upstream,
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const tooMany = res.status === 429;
      return NextResponse.json(
        {
          error: tooMany
            ? 'Voice service is busy. Try again in a moment.'
            : 'Voice service could not process that recording.',
          fallback: true,
          detail: detail.slice(0, 200),
        },
        { status: tooMany ? 429 : 502 },
      );
    }

    const json = (await res.json()) as { text?: string };
    const text = (json.text ?? '').trim();

    if (!text) {
      return NextResponse.json({ error: 'Nothing was picked up. Try again.' }, { status: 422 });
    }

    // Transcript only. The audio is now out of scope and is not persisted.
    return NextResponse.json({ transcript: text, engine: 'groq' });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    return NextResponse.json(
      {
        error: timedOut ? 'Voice service timed out.' : 'Voice service is unreachable.',
        fallback: true,
      },
      { status: 504 },
    );
  }
}
