import type { Sku, TxnType } from '@/lib/types';

/* =============================================================================
   Voice → transaction parser
   -----------------------------------------------------------------------------
   Runs entirely in the browser against the SKU catalogue already in memory.
   No model decides anything here: a transcript either matches a real SKU and a
   real number, or the worker is asked to pick. Nothing is committed without
   confirmation, and this file never touches stock.
   ========================================================================== */

export interface ParseResult {
  transcript: string;
  txnType: TxnType | null;
  quantity: number | null;
  matches: Sku[];        // best candidates, most likely first
  sku: Sku | null;       // set only when one candidate is clearly ahead
  confidence: 'high' | 'medium' | 'low';
  missing: string[];     // what the worker still has to supply
}

/* Spoken numbers, including the ones Indian English speakers use most. */
const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  ek: 1, do: 2, teen: 3, char: 4, panch: 5, chah: 6, saat: 7, aath: 8,
  nau: 9, das: 10, bees: 20, pachas: 50, sau: 100,
};

const OUT_WORDS = ['outward', 'out ward', 'out', 'issue', 'issued', 'dispatch', 'despatch',
  'sale', 'sold', 'cut', 'nikal', 'bahar', 'jama'];
const IN_WORDS = ['inward', 'in ward', 'in', 'receive', 'received', 'receipt', 'purchase',
  'purchased', 'stock in', 'andar', 'aaya'];

/** Speech engines write units inconsistently; fold them to nothing useful. */
const NOISE = /\b(meter|meters|metre|metres|mtr|mtrs|mm|piece|pieces|pcs|pc|nos|number|of|the|a|an|please|karo|kar|do)\b/g;

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "forty two" -> 42, "40 meter" -> 40.
 *
 * The hard part is telling a quantity from a size. Sizes are welded to letters
 * or hyphens (1200-8M-30, A-38, B-42), so only free-standing digit tokens are
 * ever treated as quantities, and one sitting next to a unit wins.
 */
function extractQuantity(text: string): number | null {
  const tokens = text.split(' ');
  const isBareNumber = (t: string) => /^\d+(\.\d+)?$/.test(t);
  const UNITS = new Set(['meter', 'meters', 'metre', 'metres', 'mtr', 'mtrs', 'm',
    'piece', 'pieces', 'pcs', 'pc', 'nos']);
  const DIRECTIONS = new Set([...OUT_WORDS, ...IN_WORDS]);

  // 1. a bare number immediately followed by a unit
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (isBareNumber(tokens[i]) && UNITS.has(tokens[i + 1])) return Number(tokens[i]);
  }

  // 2. a spoken number ("forty", "bees")
  let total = 0;
  let spoken = false;
  for (const word of tokens) {
    const value = WORD_NUMBERS[word];
    if (value === undefined) continue;
    spoken = true;
    total = value === 100 ? Math.max(total, 1) * 100 : total + value;
  }
  if (spoken && total > 0) return total;

  // 3. a bare number just before the direction word
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (isBareNumber(tokens[i]) && DIRECTIONS.has(tokens[i + 1])) return Number(tokens[i]);
  }

  // 4. exactly one bare number in the whole phrase
  const bare = tokens.filter(isBareNumber);
  if (bare.length === 1) return Number(bare[0]);

  return null;
}

function extractType(text: string): TxnType | null {
  const padded = ` ${text} `;
  for (const w of OUT_WORDS) if (padded.includes(` ${w} `)) return 'OUTWARD';
  for (const w of IN_WORDS) if (padded.includes(` ${w} `)) return 'INWARD';
  return null;
}

/**
 * Scores a SKU against the spoken words. Exact token hits on size and brand
 * count most; a size like "1200" appearing anywhere still counts for something.
 */
function score(sku: Sku, tokens: string[], raw: string): number {
  const size = sku.exact_size.toLowerCase();
  const brand = sku.brand_name.toLowerCase();
  const family = sku.family_code.toLowerCase();
  const compactSize = size.replace(/[\s-]/g, '');
  let s = 0;

  if (raw.includes(compactSize)) s += 60;
  else if (raw.replace(/[\s-]/g, '').includes(compactSize)) s += 55;

  if (raw.includes(brand)) s += 35;
  else if (brand.split(' ')[0] && raw.includes(brand.split(' ')[0])) s += 25;

  if (raw.includes(family)) s += 12;

  for (const t of tokens) {
    if (t.length < 2) continue;
    if (compactSize.includes(t)) s += 8;
    if (brand.startsWith(t)) s += 6;
  }

  // Numbers inside the size are strong evidence: "1200" for "1200-8M-30".
  const sizeDigits = size.match(/\d+/g) ?? [];
  for (const d of sizeDigits) {
    if (d.length >= 3 && tokens.includes(d)) s += 30;
    else if (d.length >= 2 && tokens.includes(d)) s += 10;
  }

  return s;
}

export function parseVoiceCommand(transcript: string, catalogue: Sku[]): ParseResult {
  const raw = normalise(transcript);
  const txnType = extractType(raw);
  const quantity = extractQuantity(raw);

  const cleaned = raw.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  const tokens = cleaned.split(' ').filter(Boolean);

  const ranked = catalogue
    .map((sku) => ({ sku, value: score(sku, tokens, raw) }))
    .filter((r) => r.value >= 30)
    .sort((a, b) => b.value - a.value);

  const matches = ranked.slice(0, 6).map((r) => r.sku);
  const top = ranked[0];
  const runnerUp = ranked[1];

  // Only auto-select when the leader is clearly ahead — otherwise let the
  // worker tap the right one rather than guessing on their behalf.
  const decisive = !!top && (!runnerUp || top.value - runnerUp.value >= 20);
  const sku = decisive && top.value >= 55 ? top.sku : null;

  const missing: string[] = [];
  if (!sku) missing.push('product');
  if (quantity === null || quantity <= 0) missing.push('quantity');
  if (!txnType) missing.push('direction');

  const confidence: ParseResult['confidence'] =
    missing.length === 0 && top && top.value >= 85 ? 'high'
      : missing.length <= 1 ? 'medium'
      : 'low';

  return { transcript, txnType, quantity, matches, sku, confidence, missing };
}

/** Plain-language prompt for whatever the worker still needs to supply. */
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
