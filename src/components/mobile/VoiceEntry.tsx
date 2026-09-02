'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, X, Check, RotateCcw, AlertCircle } from 'lucide-react';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import { parseVoiceCommand, missingPrompt, type ParseResult } from '@/lib/voice';
import { fmtQty } from '@/lib/format';
import type { Sku, TxnType } from '@/lib/types';

/* =============================================================================
   Voice entry
   -----------------------------------------------------------------------------
   Microphone → Groq Whisper (or the browser's engine if Groq is unavailable)
   → deterministic parser → confirmation → the same inventory engine every other
   screen uses.

   Two rules this component never breaks: voice never writes stock directly, and
   nothing is committed until a human taps Confirm. Audio is discarded the
   moment a transcript comes back.
   ========================================================================== */

type Stage = 'idle' | 'recording' | 'thinking' | 'review' | 'done';

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

export default function VoiceEntry({
  onClose, onCommitted,
}: {
  onClose: () => void;
  onCommitted: () => void;
}) {
  const { skus, applyStock } = useCatalog();
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<'groq' | 'browser' | null>(null);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [sku, setSku] = useState<Sku | null>(null);
  const [qty, setQty] = useState('');
  const [type, setType] = useState<TxnType | null>(null);
  const [result, setResult] = useState<{ name: string; qty: string; stock: string } | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => () => {
    stopTracks();
    try { recognitionRef.current?.stop(); } catch { /* already stopped */ }
  }, [stopTracks]);

  /** Runs a transcript through the parser and pre-fills whatever it resolved. */
  const handleTranscript = useCallback((transcript: string) => {
    const outcome = parseVoiceCommand(transcript, skus);
    setParsed(outcome);
    setSku(outcome.sku);
    setQty(outcome.quantity ? String(outcome.quantity) : '');
    setType(outcome.txnType);
    setStage('review');
  }, [skus]);

  /* ------------------------------------------------- browser speech engine */
  const startBrowserRecognition = useCallback(() => {
    const Ctor =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;

    if (!Ctor) {
      setError('This phone has no speech recognition available. Use the buttons instead.');
      setStage('idle');
      return;
    }

    const recognition = new Ctor();
    recognitionRef.current = recognition;
    recognition.lang = 'en-IN';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onresult = (e) => {
      const text = e.results?.[0]?.[0]?.transcript ?? '';
      setEngine('browser');
      if (text) handleTranscript(text);
      else { setError('Nothing was picked up. Try again.'); setStage('idle'); }
    };
    recognition.onerror = () => { setError('Could not hear that. Try again.'); setStage('idle'); };
    recognition.onend = () => { if (stage === 'recording') setStage('thinking'); };

    setEngine('browser');
    setStage('recording');
    recognition.start();
  }, [handleTranscript, stage]);

  /* ------------------------------------------------------ Groq recording */
  async function startRecording() {
    setError(null);
    setParsed(null);

    if (typeof MediaRecorder === 'undefined') return startBrowserRecognition();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      recorder.onstop = () => { void transcribe(); };

      recorder.start();
      setStage('recording');
    } catch {
      setError('Microphone access was refused. Allow it in your browser settings.');
      setStage('idle');
    }
  }

  function stopRecording() {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* already stopped */ }
      return;
    }
    if (recorderRef.current?.state === 'recording') {
      setStage('thinking');
      recorderRef.current.stop();
    }
  }

  async function transcribe() {
    stopTracks();
    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    chunksRef.current = [];

    if (blob.size < 1200) {
      setError('That was too short. Hold the button while you speak.');
      setStage('idle');
      return;
    }

    const form = new FormData();
    form.append('audio', blob, 'speech.webm');

    try {
      const res = await fetch('/api/voice/transcribe', { method: 'POST', body: form });
      const json = await res.json();

      if (!res.ok) {
        // Groq unavailable or rate limited: fall back rather than block the worker.
        if (json.fallback) { startBrowserRecognition(); return; }
        setError(json.error ?? 'Could not transcribe that.');
        setStage('idle');
        return;
      }

      setEngine('groq');
      handleTranscript(json.transcript as string);
    } catch {
      startBrowserRecognition();
    }
  }

  /* -------------------------------------------------------------- commit */
  async function commit() {
    if (!sku || !type) return;
    const amount = Number(qty);
    if (!Number.isFinite(amount) || amount <= 0) { setError('Enter a quantity.'); return; }

    setStage('thinking');
    const res = await fetch('/api/movements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku_code: sku.sku_code,
        txn_type: type,
        quantity: amount,
        unit_code: sku.unit_code,
        reference: 'VOICE ENTRY',
        notes: parsed?.transcript ? `Spoken: "${parsed.transcript}"` : null,
        channel: 'MOBILE_VOICE',
      }),
    });

    const json = await res.json();
    if (!res.ok) { setError(json.error ?? 'That did not go through.'); setStage('review'); return; }

    const newStock = Number(json.movement.new_stock);
    applyStock(sku.sku_code, newStock);
    setResult({
      name: `${sku.exact_size} · ${sku.brand_name}`,
      qty: fmtQty(amount, sku.unit_code),
      stock: fmtQty(newStock, sku.unit_code),
    });
    setStage('done');
  }

  function reset() {
    setStage('idle'); setParsed(null); setSku(null);
    setQty(''); setType(null); setError(null); setResult(null);
  }

  const projected = sku && qty && type
    ? type === 'OUTWARD' ? sku.current_stock - Number(qty) : sku.current_stock + Number(qty)
    : null;

  const ready = !!sku && !!type && Number(qty) > 0 &&
    (type !== 'OUTWARD' || Number(qty) <= sku.current_stock);

  return (
    <div className="fixed inset-0 z-[80] bg-canvas flex flex-col">
      <div className="flex items-center gap-3 px-4 h-14 border-b border-line shrink-0">
        <button className="btn btn-ghost h-8 w-8 p-0" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <p className="text-[15px] font-semibold">Voice entry</p>
        {engine && (
          <span className="badge badge-neutral ml-auto">
            {engine === 'groq' ? 'Whisper' : 'On-device'}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {/* ------------------------------------------------------- idle */}
        {stage === 'idle' && (
          <div className="text-center pt-8">
            <p className="text-[15px] font-medium">Hold the button and speak</p>
            <p className="text-[13px] text-ink-3 mt-2 max-w-[280px] mx-auto leading-relaxed">
              Say the size, the brand, the quantity, then in or out.
            </p>
            <p className="text-[13px] text-brand mt-4 font-medium">
              “1200-8M-30 Optibelt 40 meter outward”
            </p>

            {error && (
              <p className="mt-5 text-[13px] text-danger bg-danger-soft rounded-lg px-3.5 py-2.5 inline-flex items-center gap-2">
                <AlertCircle size={14} /> {error}
              </p>
            )}
          </div>
        )}

        {/* -------------------------------------------------- recording */}
        {stage === 'recording' && (
          <div className="text-center pt-12">
            <div className="mx-auto h-20 w-20 rounded-full bg-danger grid place-items-center recording">
              <Mic size={30} className="text-white" />
            </div>
            <p className="text-[15px] font-medium mt-6">Listening…</p>
            <p className="text-[13px] text-ink-3 mt-1">Release to finish</p>
          </div>
        )}

        {stage === 'thinking' && (
          <div className="text-center pt-12">
            <div className="mx-auto h-20 w-20 rounded-full bg-subtle grid place-items-center">
              <Mic size={30} className="text-ink-3" />
            </div>
            <p className="text-[15px] font-medium mt-6">Working it out…</p>
          </div>
        )}

        {/* ----------------------------------------------------- review */}
        {stage === 'review' && parsed && (
          <div className="space-y-4 fade-in">
            <div className="card p-4">
              <p className="eyebrow">Heard</p>
              <p className="text-[15px] mt-1.5 leading-relaxed">“{parsed.transcript}”</p>
            </div>

            {parsed.missing.length > 0 && (
              <p className="text-[13px] text-warn bg-warn-soft rounded-lg px-3.5 py-2.5">
                {missingPrompt(parsed.missing)}
              </p>
            )}

            {/* product */}
            <div>
              <p className="label">Product</p>
              {sku ? (
                <button
                  className="w-full card p-3.5 text-left active:bg-subtle"
                  onClick={() => setSku(null)}
                >
                  <p className="text-[15px] font-semibold">{sku.exact_size}</p>
                  <p className="text-[12px] text-ink-3 mt-0.5">{sku.brand_name} · {sku.family_name}</p>
                  <p className="num text-[13px] text-ink-2 mt-1.5">
                    In stock {fmtQty(sku.current_stock, sku.unit_code)}
                  </p>
                </button>
              ) : parsed.matches.length > 0 ? (
                <ul className="card divide-y divide-line overflow-hidden">
                  {parsed.matches.map((m) => (
                    <li key={m.sku_code}>
                      <button className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-subtle"
                        onClick={() => setSku(m)}>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[14px] font-medium truncate">{m.exact_size}</span>
                          <span className="block text-[12px] text-ink-3 truncate">{m.brand_name}</span>
                        </span>
                        <span className="num text-[13px] font-medium">{fmtQty(m.current_stock, m.unit_code)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-ink-3 card p-3.5">
                  No product matched. Try again, or use search on the home screen.
                </p>
              )}
            </div>

            {/* direction */}
            <div>
              <p className="label">Direction</p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  className={`btn btn-lg ${type === 'OUTWARD' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setType('OUTWARD')}
                >
                  Outward
                </button>
                <button
                  className={`btn btn-lg ${type === 'INWARD' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setType('INWARD')}
                >
                  Inward
                </button>
              </div>
            </div>

            {/* quantity */}
            <div>
              <label className="label" htmlFor="vqty">
                Quantity {sku ? `(${sku.unit_code})` : ''}
              </label>
              <input
                id="vqty"
                className="field num h-12 text-[17px]"
                inputMode="decimal"
                value={qty}
                onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="0"
              />
            </div>

            {sku && projected !== null && type && (
              <div className="card p-4 num text-[14px] space-y-1.5">
                <div className="flex justify-between text-ink-2">
                  <span>Current</span><span>{fmtQty(sku.current_stock, sku.unit_code)}</span>
                </div>
                <div className="flex justify-between text-ink-2">
                  <span>{type === 'OUTWARD' ? 'Outward' : 'Inward'}</span>
                  <span>{type === 'OUTWARD' ? '−' : '+'}{fmtQty(Number(qty || 0), sku.unit_code)}</span>
                </div>
                <div className="flex justify-between font-semibold border-t border-line pt-2 mt-2 text-[15px]">
                  <span>After</span><span>{fmtQty(projected, sku.unit_code)}</span>
                </div>
              </div>
            )}

            {sku && type === 'OUTWARD' && Number(qty) > sku.current_stock && (
              <p className="text-[13px] text-danger">
                Only {fmtQty(sku.current_stock, sku.unit_code)} available.
              </p>
            )}

            {error && <p className="text-[13px] text-danger bg-danger-soft rounded-lg px-3.5 py-2.5">{error}</p>}
          </div>
        )}

        {/* ------------------------------------------------------- done */}
        {stage === 'done' && result && (
          <div className="text-center pt-10 fade-in">
            <div className="mx-auto h-16 w-16 rounded-full bg-ok-soft grid place-items-center">
              <Check size={30} className="text-ok" />
            </div>
            <p className="text-[17px] font-semibold mt-5">Recorded</p>
            <p className="text-[14px] text-ink-2 mt-1">{result.name}</p>
            <p className="num text-[14px] text-ink-3 mt-1">{result.qty} · now {result.stock}</p>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------ controls */}
      <div className="border-t border-line bg-surface p-4 shrink-0">
        {(stage === 'idle' || stage === 'recording') && (
          <button
            className={`w-full h-16 rounded-xl flex items-center justify-center gap-3 text-[16px] font-medium text-white select-none ${
              stage === 'recording' ? 'bg-danger' : 'bg-brand active:bg-brand-hover'
            }`}
            onPointerDown={(e) => { e.preventDefault(); void startRecording(); }}
            onPointerUp={(e) => { e.preventDefault(); stopRecording(); }}
            onPointerLeave={() => { if (stage === 'recording') stopRecording(); }}
          >
            <Mic size={20} />
            {stage === 'recording' ? 'Release to finish' : 'Hold to speak'}
          </button>
        )}

        {stage === 'review' && (
          <div className="flex gap-3">
            <button className="btn btn-secondary btn-lg flex-1" onClick={reset}>
              <RotateCcw size={16} /> Again
            </button>
            <button className="btn btn-primary btn-lg flex-[1.6]" disabled={!ready} onClick={commit}>
              <Check size={16} /> Confirm
            </button>
          </div>
        )}

        {stage === 'done' && (
          <div className="flex gap-3">
            <button className="btn btn-secondary btn-lg flex-1" onClick={reset}>Record another</button>
            <button className="btn btn-primary btn-lg flex-1" onClick={onCommitted}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}
