'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, X, Check, RotateCcw, ArrowUpRight, ArrowDownLeft, Volume2 } from 'lucide-react';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import { parseVoiceCommand } from '@/lib/voice';
import { fmtQty } from '@/lib/format';
import type { Sku, TxnType } from '@/lib/types';

/* =============================================================================
   Voice entry — two taps, start to finish.
   -----------------------------------------------------------------------------
     Tap 1  hold nothing, just tap: it listens, stops on its own when you stop
            talking, and goes straight to the confirmation
     Tap 2  approve

   Recognition runs in the browser (Web Speech API): no key, no upload, no cost,
   and about a second to a result. Parsing is local and deterministic. Stock is
   only ever changed by the same database routine every other screen uses.

   The confirmation is built to be checked in about two seconds — one product,
   one big number, one resulting figure — and it is also read aloud, so it can
   be verified without looking while hands are full.
   ========================================================================== */

type Stage = 'idle' | 'listening' | 'confirm' | 'saving' | 'done';

interface RecognitionEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

function recogniser(): SpeechRecognitionLike | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

/** Short tones, so the flow can be followed without watching the screen. */
function beep(kind: 'start' | 'stop' | 'ok' | 'fail') {
  try {
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const notes = kind === 'ok' ? [660, 880] : kind === 'fail' ? [320, 240] : kind === 'start' ? [780] : [520];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.value = 0.09;
      osc.connect(gain).connect(ctx.destination);
      const at = ctx.currentTime + i * 0.11;
      osc.start(at);
      osc.stop(at + 0.1);
    });
    setTimeout(() => void ctx.close(), 600);
  } catch {
    // Sound is a convenience, never a requirement.
  }
}

function say(text: string) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-IN';
    utterance.rate = 1.02;
    synth.speak(utterance);
  } catch {
    // Silent devices are fine; the screen still shows everything.
  }
}

export default function VoiceEntry({
  onClose, onCommitted,
}: {
  onClose: () => void;
  onCommitted: () => void;
}) {
  const { skus, applyStock } = useCatalog();
  const [stage, setStage] = useState<Stage>('idle');
  const [heard, setHeard] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [supported, setSupported] = useState(true);

  const [sku, setSku] = useState<Sku | null>(null);
  const [alternates, setAlternates] = useState<Sku[]>([]);
  const [quantity, setQuantity] = useState<number | null>(null);
  const [txnType, setTxnType] = useState<TxnType | null>(null);
  const [result, setResult] = useState<{ name: string; line: string } | null>(null);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    setSupported(!!recogniser());
    return () => { try { recRef.current?.abort(); } catch { /* already stopped */ } };
  }, []);

  /** Transcript in, confirmation on screen. */
  const interpret = useCallback((text: string) => {
    const parsed = parseVoiceCommand(text, skus);
    setHeard(text);

    // Several brands often stock the same size. Rather than forcing a choice,
    // lead with the one holding the most stock — overwhelmingly the one being
    // issued — and offer the rest as one-tap alternatives. The brand is shown
    // large on the confirmation, so a wrong guess is obvious before approving.
    const ranked = [...parsed.matches].sort((a, b) => b.current_stock - a.current_stock);
    const pick = parsed.sku ?? ranked[0] ?? null;

    setSku(pick);
    setAlternates(ranked.filter((s) => s.sku_code !== pick?.sku_code).slice(0, 4));
    setQuantity(parsed.quantity);
    setTxnType(parsed.txnType);
    setStage('confirm');

    if (pick && parsed.quantity && parsed.txnType) {
      beep('ok');
      const after = parsed.txnType === 'OUTWARD'
        ? pick.current_stock - parsed.quantity
        : pick.current_stock + parsed.quantity;
      say(`${pick.exact_size}, ${pick.brand_name}, ${parsed.quantity} ${pick.unit_code === 'MTR' ? 'meters' : 'pieces'} ${parsed.txnType === 'OUTWARD' ? 'out' : 'in'}. ${after} left.`);
    } else {
      beep('fail');
    }
  }, [skus]);

  function listen() {
    setError(null);
    setHeard('');
    settled.current = false;

    const rec = recogniser();
    if (!rec) { setSupported(false); return; }

    recRef.current = rec;
    rec.lang = 'en-IN';
    rec.continuous = false;      // stops by itself when speech ends
    rec.interimResults = true;   // show words as they arrive
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      let text = '';
      let final = false;
      for (let i = 0; i < e.results.length; i += 1) {
        text += e.results[i][0].transcript;
        if (e.results[i].isFinal) final = true;
      }
      setHeard(text);
      if (final && text.trim()) {
        settled.current = true;
        try { rec.stop(); } catch { /* already stopping */ }
        interpret(text.trim());
      }
    };

    rec.onerror = (e) => {
      settled.current = true;
      beep('fail');
      setStage('idle');
      setError(
        e.error === 'not-allowed'
          ? 'Microphone blocked. Allow it in your browser settings.'
          : e.error === 'no-speech'
          ? 'Nothing heard. Tap and speak again.'
          : e.error === 'network'
          ? 'No network. Type it instead.'
          : 'Could not hear that. Try again.',
      );
    };

    rec.onend = () => {
      if (settled.current) return;
      setStage((s) => (s === 'listening' ? 'idle' : s));
    };

    beep('start');
    setStage('listening');
    rec.start();
  }

  function stopListening() {
    try { recRef.current?.stop(); } catch { /* already stopped */ }
    beep('stop');
  }

  async function approve() {
    if (!sku || !txnType || !quantity) return;
    setStage('saving');
    setError(null);

    const res = await fetch('/api/movements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku_code: sku.sku_code,
        txn_type: txnType,
        quantity,
        unit_code: sku.unit_code,
        reference: 'VOICE ENTRY',
        notes: heard ? `Spoken: "${heard}"` : null,
        channel: 'MOBILE_VOICE',
      }),
    });

    const json = await res.json();
    if (!res.ok) {
      beep('fail');
      setStage('confirm');
      setError(json.error ?? 'That did not go through.');
      return;
    }

    const newStock = Number(json.movement.new_stock);
    applyStock(sku.sku_code, newStock);
    beep('ok');
    say('Saved.');
    setResult({
      name: `${sku.exact_size} · ${sku.brand_name}`,
      line: `${fmtQty(quantity, sku.unit_code)} ${txnType === 'OUTWARD' ? 'out' : 'in'} · now ${fmtQty(newStock, sku.unit_code)}`,
    });
    setStage('done');
  }

  function reset() {
    setStage('idle'); setHeard(''); setError(null); setTyped('');
    setSku(null); setAlternates([]); setQuantity(null); setTxnType(null); setResult(null);
  }

  const after = sku && quantity && txnType
    ? txnType === 'OUTWARD' ? sku.current_stock - quantity : sku.current_stock + quantity
    : null;

  const ready = !!sku && !!txnType && !!quantity && quantity > 0 &&
    (txnType !== 'OUTWARD' || quantity <= sku.current_stock);

  return (
    <div className="fixed inset-0 z-[80] bg-canvas flex flex-col">
      <div className="flex items-center gap-3 px-4 h-14 border-b border-line shrink-0">
        <button className="btn btn-ghost h-9 w-9 p-0" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>
        <p className="text-[16px] font-semibold">
          {stage === 'confirm' || stage === 'saving' ? 'Check and approve' : 'Voice entry'}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* ============================================ 1. record ========= */}
        {(stage === 'idle' || stage === 'listening') && (
          <div className="h-full flex flex-col items-center justify-center px-6 text-center">
            {stage === 'listening' ? (
              <>
                <button
                  onClick={stopListening}
                  className="h-36 w-36 rounded-full bg-danger grid place-items-center recording"
                  aria-label="Stop"
                >
                  <Mic size={54} className="text-white" />
                </button>
                <p className="text-[19px] font-semibold mt-7">Listening…</p>
                <p className="text-[15px] text-ink-2 mt-2 min-h-[48px] px-4">
                  {heard || 'Speak now'}
                </p>
              </>
            ) : (
              <>
                <button
                  onClick={listen}
                  disabled={!supported}
                  className="h-36 w-36 rounded-full bg-brand grid place-items-center active:bg-brand-hover disabled:opacity-40 shadow-md"
                  aria-label="Start recording"
                >
                  <Mic size={54} className="text-white" />
                </button>
                <p className="text-[19px] font-semibold mt-7">Tap and speak</p>
                <p className="text-[14px] text-ink-3 mt-2 max-w-[280px] leading-relaxed">
                  Say the size, the brand, how many, then in or out.
                </p>
                <p className="text-[14px] text-brand font-medium mt-4">
                  “1200 8M 30 Megadyne 40 meters out”
                </p>
              </>
            )}

            {error && (
              <p className="text-[14px] text-danger bg-danger-soft rounded-lg px-4 py-2.5 mt-6">
                {error}
              </p>
            )}

            {/* Only surfaces when the microphone cannot be used at all. */}
            {(!supported || error) && stage === 'idle' && (
              <div className="w-full max-w-[340px] mt-6">
                <input
                  className="field h-12 text-[16px]"
                  placeholder="Or type it here"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && typed.trim()) interpret(typed.trim());
                  }}
                />
                <button
                  className="btn btn-secondary btn-lg w-full mt-2"
                  disabled={!typed.trim()}
                  onClick={() => interpret(typed.trim())}
                >
                  Check it
                </button>
              </div>
            )}
          </div>
        )}

        {/* =========================================== 2. approve ========= */}
        {(stage === 'confirm' || stage === 'saving') && (
          <div className="p-4 space-y-3 fade-in">
            {heard && (
              <p className="text-[13px] text-ink-3 text-center px-2">“{heard}”</p>
            )}

            {sku ? (
              <>
                <div className="card p-5">
                  <p className="text-[24px] font-semibold leading-tight">{sku.exact_size}</p>
                  <p className="text-[15px] text-ink-2 mt-1">{sku.brand_name}</p>

                  <div className="mt-5 space-y-2.5 num text-[16px]">
                    <div className="flex items-center justify-between text-ink-2">
                      <span>In stock now</span>
                      <span>{fmtQty(sku.current_stock, sku.unit_code)}</span>
                    </div>

                    <div className={`flex items-center justify-between font-semibold ${
                      txnType === 'OUTWARD' ? 'text-brand' : txnType === 'INWARD' ? 'text-ok' : 'text-warn'
                    }`}>
                      <span className="flex items-center gap-1.5">
                        {txnType === 'OUTWARD' ? <ArrowUpRight size={18} />
                          : txnType === 'INWARD' ? <ArrowDownLeft size={18} /> : null}
                        {txnType === 'OUTWARD' ? 'Going out' : txnType === 'INWARD' ? 'Coming in' : 'In or out?'}
                      </span>
                      <span>
                        {txnType === 'OUTWARD' ? '−' : txnType === 'INWARD' ? '+' : ''}
                        {quantity ? fmtQty(quantity, sku.unit_code) : '—'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[20px] font-semibold border-t border-line pt-3 mt-1">
                      <span className="text-[15px] font-medium text-ink-2">Left after this</span>
                      <span className={after !== null && after < 0 ? 'text-danger' : ''}>
                        {after !== null ? fmtQty(after, sku.unit_code) : '—'}
                      </span>
                    </div>
                  </div>

                  <button
                    className="btn btn-ghost btn-sm mt-3 -ml-2"
                    onClick={() => {
                      if (!quantity || !txnType) return;
                      say(`${sku.exact_size}, ${sku.brand_name}, ${quantity} ${txnType === 'OUTWARD' ? 'out' : 'in'}. ${after} left.`);
                    }}
                  >
                    <Volume2 size={14} /> Read it out
                  </button>
                </div>

                {alternates.length > 0 && (
                  <div>
                    <p className="text-[12px] text-ink-3 mb-1.5">Wrong one? Tap the right brand.</p>
                    <div className="flex flex-wrap gap-2">
                      {alternates.map((a) => (
                        <button
                          key={a.sku_code}
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            const previous = sku;
                            setSku(a);
                            setAlternates((list) =>
                              [previous, ...list.filter((x) => x.sku_code !== a.sku_code)].filter(Boolean) as Sku[]);
                          }}
                        >
                          {a.brand_name}
                          <span className="num text-ink-3 ml-1">{fmtQty(a.current_stock, a.unit_code)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="card p-5 text-center">
                <p className="text-[16px] font-medium">No product matched</p>
                <p className="text-[14px] text-ink-3 mt-1.5">
                  Tap Again and say the size more slowly, or add the brand.
                </p>
              </div>
            )}

            {/* Only appears when something could not be worked out. */}
            {sku && !txnType && (
              <div className="grid grid-cols-2 gap-3">
                <button className="btn btn-secondary btn-lg" onClick={() => setTxnType('OUTWARD')}>
                  <ArrowUpRight size={18} /> Going out
                </button>
                <button className="btn btn-secondary btn-lg" onClick={() => setTxnType('INWARD')}>
                  <ArrowDownLeft size={18} /> Coming in
                </button>
              </div>
            )}

            {sku && !quantity && (
              <div>
                <label className="label" htmlFor="q">How many ({sku.unit_code})?</label>
                <input
                  id="q" className="field num h-12 text-[18px]" inputMode="numeric" autoFocus
                  onChange={(e) => setQuantity(Number(e.target.value.replace(/[^0-9.]/g, '')) || null)}
                />
              </div>
            )}

            {sku && txnType === 'OUTWARD' && quantity && quantity > sku.current_stock && (
              <p className="text-[14px] text-danger bg-danger-soft rounded-lg px-4 py-2.5">
                Only {fmtQty(sku.current_stock, sku.unit_code)} in stock.
              </p>
            )}

            {error && (
              <p className="text-[14px] text-danger bg-danger-soft rounded-lg px-4 py-2.5">{error}</p>
            )}
          </div>
        )}

        {/* ============================================== 3. done ========= */}
        {stage === 'done' && result && (
          <div className="h-full flex flex-col items-center justify-center px-6 text-center fade-in">
            <div className="h-24 w-24 rounded-full bg-ok-soft grid place-items-center">
              <Check size={48} className="text-ok" />
            </div>
            <p className="text-[22px] font-semibold mt-6">Saved</p>
            <p className="text-[16px] text-ink-2 mt-2">{result.name}</p>
            <p className="num text-[15px] text-ink-3 mt-1">{result.line}</p>
          </div>
        )}
      </div>

      {/* ----------------------------------------------------- controls */}
      <div className="border-t border-line bg-surface p-4 shrink-0">
        {(stage === 'confirm' || stage === 'saving') && (
          <div className="flex gap-3">
            <button className="btn btn-secondary btn-lg flex-1" onClick={reset} disabled={stage === 'saving'}>
              <RotateCcw size={18} /> Again
            </button>
            <button
              className="btn btn-primary btn-lg flex-[2] text-[16px]"
              disabled={!ready || stage === 'saving'}
              onClick={approve}
            >
              <Check size={20} /> {stage === 'saving' ? 'Saving…' : 'Approve'}
            </button>
          </div>
        )}

        {stage === 'done' && (
          <div className="flex gap-3">
            <button className="btn btn-secondary btn-lg flex-1" onClick={reset}>Another</button>
            <button className="btn btn-primary btn-lg flex-1" onClick={onCommitted}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}
