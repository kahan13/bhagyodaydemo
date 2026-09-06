import type { Sku, TxnType } from '@/lib/types';

/* =============================================================================
   Spoken text → transaction
   -----------------------------------------------------------------------------
   Input comes from the phone keyboard's own dictation, so this file receives
   plain text and nothing else. No audio, no API, no key.

   The difficulty is that nobody dictates a part number the way it is printed.
   "1200-8M-30" arrives as "twelve hundred 8m 30", or "one two zero zero eight
   m thirty", never with the hyphens. So rather than trying to read the
   sentence, this reduces both sides to a comparable signature and searches:

     spoken     "twelve hundred 8m 30 40 meters outward"
     folded     1200 8 m 30 40 meters outward
     minus quantity, unit and direction
     signature  12008M30        compared against 1200-8M-30 stripped

   Which number is the quantity is not decided up front. Every plausible split
   is tried and scored against the catalogue, and the reading that produces the
   best product match wins. That is what lets "1200 8 30 40" resolve without
   knowing in advance that 40 is the quantity.
   ========================================================================== */

export interface ParseResult {
  transcript: string;
  normalised: string;
  txnType: TxnType | null;
  quantity: number | null;
  matches: Sku[];
  sku: Sku | null;
  confidence: 'high' | 'medium' | 'low';
  missing: string[];
}

/* ------------------------------------------------------------------ lexicon */

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9,
  // Hinglish, as spoken on the shop floor
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, panch: 5, paanch: 5,
  chhe: 6, che: 6, chah: 6, saat: 7, aath: 8, nau: 9,
};

const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  das: 10, gyarah: 11, barah: 12, terah: 13, chaudah: 14, pandrah: 15,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
  bees: 20, tees: 30, chalis: 40, chalees: 40, pachas: 50, pachaas: 50,
  sattar: 70, assi: 80, nabbe: 90,
};

const SCALES: Record<string, number> = {
  hundred: 100, sau: 100, thousand: 1000, hazaar: 1000, hazar: 1000,
};

const UNIT_WORDS = new Set([
  'meter', 'meters', 'metre', 'metres', 'mtr', 'mtrs', 'mt',
  'piece', 'pieces', 'pcs', 'pc', 'nos', 'quantity', 'qty',
]);

const OUT_WORDS = new Set([
  'outward', 'out', 'outwards', 'issue', 'issued', 'issuing', 'dispatch',
  'despatch', 'dispatched', 'sale', 'sold', 'sell', 'cut', 'deliver',
  'delivered', 'nikal', 'nikalo', 'bahar',
]);

const IN_WORDS = new Set([
  'inward', 'in', 'inwards', 'receive', 'received', 'receipt', 'purchase',
  'purchased', 'bought', 'andar', 'aaya', 'aya', 'liya',
]);

// Filler that carries no meaning here.
const NOISE = new Set([
  'the', 'a', 'an', 'of', 'and', 'please', 'karo', 'kar', 'kardo',
  'add', 'entry', 'record', 'make', 'belt', 'belts', 'size', 'brand',
  'is', 'it', 'to', 'for', 'from', 'ka', 'ke', 'ki', 'mein', 'stock',
]);

/* ------------------------------------------------------------ tokenisation */

/**
 * Splits letter/digit boundaries so dictation quirks stop mattering:
 * "8m" -> "8 m", "40meters" -> "40 meters", "xpa1400" -> "xpa 1400".
 */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .split(' ')
    .filter(Boolean);
}

const isDigits = (t: string) => /^\d+$/.test(t);

const numberWord = (t: string): number | null =>
  t in ONES ? ONES[t]
    : t in TEENS ? TEENS[t]
    : t in TENS ? TENS[t]
    : t in SCALES ? SCALES[t]
    : null;

/**
 * Turns runs of number words into digit tokens.
 *
 *   "twelve hundred"     -> 1200     composed
 *   "one two zero zero"  -> 1200     spelled out digit by digit
 *   "thirty forty"       -> 30, 40   two numbers, not seventy: nobody composes
 *                                    two tens, so this splits instead of adding
 */
function foldNumbers(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    if (numberWord(tokens[i]) === null) { out.push(tokens[i]); i += 1; continue; }

    const run: string[] = [];
    while (i < tokens.length && numberWord(tokens[i]) !== null) { run.push(tokens[i]); i += 1; }

    // Two or more single digits in a row: it was spelled out.
    if (run.length >= 2 && run.every((w) => w in ONES)) {
      out.push(run.map((w) => ONES[w]).join(''));
      continue;
    }

    let current = 0;
    let total = 0;
    let openTens = false;

    const flush = () => {
      out.push(String(total + current));
      total = 0; current = 0; openTens = false;
    };

    for (const w of run) {
      if (w in SCALES) {
        const scale = SCALES[w];
        if (scale === 100) current = (current || 1) * 100;
        else { total += (current || 1) * 1000; current = 0; }
        openTens = false;
      } else if (w in TENS) {
        if (current !== 0 || total !== 0) flush();
        current = TENS[w];
        openTens = true;
      } else if (w in TEENS) {
        if (current !== 0 || total !== 0) flush();
        current = TEENS[w];
      } else {
        if (openTens && current % 10 === 0) { current += ONES[w]; openTens = false; }
        else { if (current !== 0 || total !== 0) flush(); current = ONES[w]; }
      }
    }
    flush();
  }

  return out;
}

/* ---------------------------------------------------------------- matching */

/** Strips everything but letters and digits: "1200-8M-30" -> "12008M30". */
const compact = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** True if every character of `small` appears in `large`, in order. */
function isSubsequence(small: string, large: string): boolean {
  let i = 0;
  for (const ch of large) if (ch === small[i]) i += 1;
  return i === small.length;
}

/**
 * 0–100: how well a spoken signature matches a printed size.
 *
 * Digits are compared exactly and never fuzzily. On a part number one wrong
 * digit is a different product — A-38 and A-30 are not near-misses, and issuing
 * stock against the wrong one because they look similar would be worse than
 * asking. Letters are allowed to be loose, because people routinely drop them:
 * "1200 8M 30" for 1200-S8M-30.
 */
function sizeScore(signature: string, size: string): number {
  const target = compact(size);
  if (!signature || !target) return 0;
  if (signature === target) return 100;

  const sigDigits = signature.match(/\d+/g) ?? [];
  const tgtDigits = target.match(/\d+/g) ?? [];

  // Grouping may differ ("1000" heard as "10 00"), the digits themselves may not.
  if (sigDigits.join('') !== tgtDigits.join('')) return 0;

  const sigLetters = signature.replace(/[^A-Z]/g, '');
  const tgtLetters = target.replace(/[^A-Z]/g, '');

  if (sigLetters === tgtLetters) return 96;

  // Spoken letters are a subset of printed ones: the S of S8M went unsaid.
  if (isSubsequence(sigLetters, tgtLetters)) {
    return Math.max(62, 88 - (tgtLetters.length - sigLetters.length) * 6);
  }
  // Or the reverse: they said more than is printed.
  if (isSubsequence(tgtLetters, sigLetters)) {
    return Math.max(58, 82 - (sigLetters.length - tgtLetters.length) * 6);
  }

  const distance = levenshtein(sigLetters, tgtLetters);
  const ratio = 1 - distance / Math.max(sigLetters.length, tgtLetters.length, 1);
  return ratio >= 0.6 ? Math.round(50 + ratio * 20) : 0;
}

function brandVocabulary(catalogue: Sku[]): { name: string; tokens: Set<string> }[] {
  const seen = new Map<string, { name: string; tokens: Set<string> }>();
  for (const s of catalogue) {
    if (seen.has(s.brand_name)) continue;
    const tokens = new Set(tokenise(s.brand_name).filter((t) => t.length >= 4));
    if (tokens.size) seen.set(s.brand_name, { name: s.brand_name, tokens });
  }
  return [...seen.values()];
}

/* ------------------------------------------------------------------ parser */

export function parseVoiceCommand(transcript: string, catalogue: Sku[]): ParseResult {
  const tokens = foldNumbers(tokenise(transcript));

  // Direction, scanned from the end since it is almost always said last.
  let txnType: TxnType | null = null;
  const directionAt = new Set<number>();
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (OUT_WORDS.has(tokens[i])) { txnType = txnType ?? 'OUTWARD'; directionAt.add(i); }
    else if (IN_WORDS.has(tokens[i])) { txnType = txnType ?? 'INWARD'; directionAt.add(i); }
  }

  // Brand: removed from the signature, kept as a filter.
  let brandName: string | null = null;
  const brandAt = new Set<number>();
  for (const b of brandVocabulary(catalogue)) {
    for (let i = 0; i < tokens.length; i += 1) {
      if (b.tokens.has(tokens[i])) { brandName = b.name; brandAt.add(i); }
    }
    if (brandName) break;
  }

  const unitAt = new Set<number>();
  tokens.forEach((t, i) => { if (UNIT_WORDS.has(t)) unitAt.add(i); });

  const numericAt: number[] = [];
  tokens.forEach((t, i) => { if (isDigits(t) && !brandAt.has(i)) numericAt.push(i); });

  // Every plausible reading: each number might be the quantity, or none is.
  const candidates: { index: number | null; bias: number }[] = [{ index: null, bias: 0 }];
  for (const i of numericAt) {
    let bias = 0;
    if (unitAt.has(i + 1)) bias += 60;                         // "40 meters"
    if (directionAt.has(i + 1)) bias += 34;                    // "40 outward"
    if (i === numericAt[numericAt.length - 1]) bias += 20;     // said last
    if (Number(tokens[i]) <= 999) bias += 6;
    if (tokens[i].length >= 3 && !unitAt.has(i + 1) && !directionAt.has(i + 1)) bias -= 14;
    candidates.push({ index: i, bias });
  }

  const drop = (i: number, quantityIndex: number | null) =>
    i === quantityIndex || unitAt.has(i) || directionAt.has(i) ||
    brandAt.has(i) || NOISE.has(tokens[i]);

  // `score` ranks readings against each other and includes the quantity bias.
  // `topValue` / `runnerUp` are raw match strengths, and only those two decide
  // whether the winner is clear — mixing the bias in here is what made this
  // auto-select while several brands were still tied.
  let best = {
    sku: null as Sku | null,
    score: 0,
    topValue: 0,
    runnerUp: 0,
    quantity: null as number | null,
    ranked: [] as Sku[],
  };

  for (const candidate of candidates) {
    const signature = tokens.filter((_, i) => !drop(i, candidate.index)).join('').toUpperCase();
    if (!signature) continue;

    const collect = (restrictToBrand: boolean) => {
      const found: { sku: Sku; value: number }[] = [];
      for (const sku of catalogue) {
        if (restrictToBrand && brandName && sku.brand_name !== brandName) continue;
        const value = sizeScore(signature, sku.exact_size);
        if (value >= 55) found.push({ sku, value });
      }
      return found;
    };

    // If the named brand does not stock that size, still show the size rather
    // than nothing — people misremember brands more often than part numbers.
    let scored = collect(true);
    let brandMissed = false;
    if (!scored.length && brandName) { scored = collect(false); brandMissed = scored.length > 0; }
    if (!scored.length) continue;
    scored.sort((a, b) => b.value - a.value);
    if (brandMissed) scored.forEach((x) => { x.value -= 18; });

    const combined = scored[0].value + candidate.bias * 0.35;
    if (combined > best.score) {
      best = {
        sku: scored[0].sku,
        score: combined,
        topValue: scored[0].value,
        runnerUp: scored[1]?.value ?? 0,
        quantity: candidate.index === null ? null : Number(tokens[candidate.index]),
        ranked: scored.slice(0, 8).map((s) => s.sku),
      };
    }
  }

  // Auto-select only when the leader is clearly ahead. Otherwise show the
  // candidates and let the worker tap, rather than guessing on their behalf.
  // Several brands often stock the identical size. When they do, the top two
  // score the same and the worker is asked which one — issuing stock against
  // the wrong brand is not a recoverable mistake.
  const decisive = best.topValue >= 80 && (best.runnerUp === 0 || best.topValue - best.runnerUp >= 12);
  const sku = decisive ? best.sku : null;
  const quantity = best.quantity && best.quantity > 0 ? best.quantity : null;

  const missing: string[] = [];
  if (!sku) missing.push('product');
  if (!quantity) missing.push('quantity');
  if (!txnType) missing.push('direction');

  return {
    transcript,
    normalised: tokens.join(' '),
    txnType,
    quantity,
    matches: best.ranked,
    sku,
    confidence: missing.length === 0 && best.topValue >= 96 ? 'high'
      : missing.length <= 1 ? 'medium' : 'low',
    missing,
  };
}

export function missingPrompt(missing: string[]): string {
  if (!missing.length) return '';
  const map: Record<string, string> = {
    product: 'which product',
    quantity: 'how many',
    direction: 'in or out',
  };
  const parts = missing.map((m) => map[m] ?? m);
  if (parts.length === 1) return `Tell me ${parts[0]}.`;
  return `Tell me ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
}
