/**
 * sheet-config.ts — the ONE place that defines what the system expects from a
 * sheet, for both imports (Products and Inventory) and for manual "Add Product".
 *
 * To rename a field, add a column, or support another sheet header spelling,
 * edit ONLY this file — the import screens, the preview, the server routes and
 * the Add Product form are all driven from these definitions.
 *
 * Mirrors the real KAHAN workbook:
 *   Timing   : CUT PCS/FULL SLEEVE | PRODUCT FAMILY | SECTION OF TIMING BELT | SIZE | UOM IN MM | QTY | MAKE | LOCATION | REMARKS
 *   V-Belt   : PRODUCT FAMILY | MAKE | SECTION OF V BELT | SIZE | UOM (PCS) | REMARKS | LOCATION
 *   Conveyor : PRODUCT FAMILY | COLOUR | MAKE | L | W | T | QTY | LOCATION | REMARKS
 */

import type { ProductType } from '@/lib/types';

export type ImportKind = 'SKU' | 'INVENTORY';

export type FieldKey =
  | 'family' | 'section' | 'size' | 'colour' | 'brand'
  | 'length' | 'width' | 'thickness'
  | 'lot_type' | 'uom_mm' | 'qty' | 'location' | 'remarks';

export interface FieldDef {
  key: FieldKey;
  /** The label shown on screen — deliberately the sheet's own wording. */
  label: string;
  required?: boolean;
  /** Sheet header spellings that auto-match this field (compared normalised). */
  aliases: string[];
  /** Short hint shown under the field in the mapping table. */
  hint?: string;
}

export interface TypeMeta {
  label: string;
  short: string;
  /** SKU code prefix: TB-L-165-OPTI */
  prefix: string;
  /** Unit stock is counted in. Timing belts are tracked in millimetres. */
  unit: 'MM' | 'PCS';
  /** Timing belts have Cut Pcs / Full Sleeve lots; the others are plain stock. */
  usesLots: boolean;
  /** Words that identify this type from a sheet/tab name. */
  sheetHints: string[];
  /** Headings of the 3 inventory panes. Brand is shown inside the 3rd pane. */
  levels: [string, string, string];
}

export const PRODUCT_TYPES: ProductType[] = ['TIMING_BELT', 'V_BELT', 'CONVEYOR_BELT'];

export const TYPE_META: Record<ProductType, TypeMeta> = {
  TIMING_BELT: {
    label: 'Timing Belts', short: 'Timing', prefix: 'TB', unit: 'MM', usesLots: true,
    sheetHints: ['timing'],
    levels: ['Product Family', 'Section', 'Size · Brand'],
  },
  V_BELT: {
    label: 'V-Belts', short: 'V-Belt', prefix: 'VB', unit: 'PCS', usesLots: false,
    sheetHints: ['v belt', 'vbelt', 'v-belt'],
    levels: ['Product Family', 'Section', 'Size · Brand'],
  },
  CONVEYOR_BELT: {
    label: 'Conveyor Belts', short: 'Conveyor', prefix: 'CB', unit: 'PCS', usesLots: false,
    sheetHints: ['conveyor'],
    levels: ['Product Family', 'Colour', 'Size · Brand'],
  },
};

/** Guess the product type from a sheet/tab name (returns null if unsure). */
export function detectProductType(sheetName: string): ProductType | null {
  const s = sheetName.toLowerCase();
  for (const t of PRODUCT_TYPES) {
    if (TYPE_META[t].sheetHints.some((h) => s.includes(h))) return t;
  }
  return null;
}

// ── Field definitions ────────────────────────────────────────────────────────

const F = {
  family:   { key: 'family',   label: 'Product Family', required: true, aliases: ['product family', 'family'] } as FieldDef,
  brand:    { key: 'brand',    label: 'Make',           required: true, aliases: ['make', 'brand'] } as FieldDef,
  size:     { key: 'size',     label: 'Size',           required: true, aliases: ['size'] } as FieldDef,
  colour:   { key: 'colour',   label: 'Colour',         required: true, aliases: ['colour', 'color'] } as FieldDef,
  length:   { key: 'length',   label: 'L (Length)',     required: true, aliases: ['l', 'length'] } as FieldDef,
  width:    { key: 'width',    label: 'W (Width)',      required: true, aliases: ['w', 'width'] } as FieldDef,
  thickness:{ key: 'thickness',label: 'T (Thickness)',  aliases: ['t', 'thickness'], hint: 'Optional — some round belts have none' } as FieldDef,
  location: { key: 'location', label: 'Location',       aliases: ['location', 'rack', 'rack location'] } as FieldDef,
  remarks:  { key: 'remarks',  label: 'Remarks',        aliases: ['remarks', 'remark'] } as FieldDef,
};

const sectionField = (label: string, aliases: string[]): FieldDef =>
  ({ key: 'section', label, required: true, aliases: [...aliases, 'section'] });

/** Fields that identify the PRODUCT (what a SKU is). Same for both imports. */
const IDENTITY: Record<ProductType, FieldDef[]> = {
  TIMING_BELT: [
    F.family,
    sectionField('Section of Timing Belt', ['section of timing belt']),
    F.size,
    F.brand,
  ],
  V_BELT: [
    F.family,
    sectionField('Section of V Belt', ['section of v belt']),
    F.size,
    F.brand,
  ],
  CONVEYOR_BELT: [F.family, F.colour, F.brand, F.length, F.width, F.thickness],
};

/** Product (SKU) import: identity only. No stock, no cut/full, no location. */
export const SKU_FIELDS: Record<ProductType, FieldDef[]> = IDENTITY;

/** Inventory import: identity (to find the SKU) + what is physically in stock. */
export const INVENTORY_FIELDS: Record<ProductType, FieldDef[]> = {
  TIMING_BELT: [
    ...IDENTITY.TIMING_BELT,
    { key: 'lot_type', label: 'Cut Pcs / Full Sleeve', required: true,
      aliases: ['cut pcs/ full sleeve', 'cut pcs/full sleeve', 'cut pcs full sleeve', 'cut full'],
      hint: 'CUT PCS or FULL SLEEVE' },
    { key: 'uom_mm', label: 'UOM in MM', required: true, aliases: ['uom in mm', 'uom mm'],
      hint: 'Length of ONE piece / roll in mm' },
    { key: 'qty', label: 'QTY', required: true, aliases: ['qty', 'quantity'],
      hint: 'How many such pieces / rolls' },
    F.location, F.remarks,
  ],
  V_BELT: [
    ...IDENTITY.V_BELT,
    { key: 'qty', label: 'UOM (PCS)', required: true, aliases: ['uom (pcs)', 'uom pcs', 'qty', 'quantity'],
      hint: 'Pieces in stock' },
    F.location, F.remarks,
  ],
  CONVEYOR_BELT: [
    ...IDENTITY.CONVEYOR_BELT,
    { key: 'qty', label: 'QTY', required: true, aliases: ['qty', 'quantity'], hint: 'Pieces in stock' },
    F.location, F.remarks,
  ],
};

export const fieldsFor = (kind: ImportKind, type: ProductType): FieldDef[] =>
  (kind === 'SKU' ? SKU_FIELDS : INVENTORY_FIELDS)[type];

// ── Header matching ──────────────────────────────────────────────────────────

export const normHeader = (s: unknown): string =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Exact (normalised) match of sheet headers to fields — no fuzzy guessing. */
export function autoMap(headers: string[], fields: FieldDef[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of fields) {
    const wanted = new Set([f.label, ...f.aliases].map(normHeader));
    const hit = headers.find((h) => !used.has(h) && wanted.has(normHeader(h)));
    if (hit) { out[f.key] = hit; used.add(hit); }
  }
  return out;
}

// ── Cell helpers ─────────────────────────────────────────────────────────────

export const cleanText = (v: unknown): string =>
  v === null || v === undefined ? '' : String(v).trim().replace(/\s+/g, ' ');

export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

const fmtNum = (n: number): string => String(Number(n.toFixed(3)));

const slug = (s: string): string =>
  s.toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9.]+/g, '-').replace(/^-+|-+$/g, '');

const keyPart = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export type LotType = 'CUT_PCS' | 'FULL_SLEEVE';

/** "CUT PCS" / "cut" -> CUT_PCS ; "FULL SLEEVE" / "full" -> FULL_SLEEVE ; else null */
export function parseLotType(v: unknown): LotType | null {
  const s = cleanText(v).toUpperCase().replace(/[\s_]+/g, '');
  if (!s) return null;
  if (s.startsWith('CUT')) return 'CUT_PCS';
  if (s.startsWith('FULL') || s.startsWith('SLEEVE')) return 'FULL_SLEEVE';
  return null;
}

// ── Product identity ─────────────────────────────────────────────────────────

export interface Identity {
  type: ProductType;
  family: string;
  /** Section (belts) — null for conveyor. */
  section: string | null;
  /** Colour — conveyor only. */
  colour: string | null;
  brand: string;
  /** Belts: "165".  Conveyor: "200 X 500 X 1.5". */
  sizeLabel: string;
  lengthMm: number | null;
  widthMm: number | null;
  thicknessMm: number | null;
  /** Unique per physical product, e.g. timing_belt|classical|l|165|opti */
  key: string;
  /** hier_l1 / l2 / l3 for the Inventory drill-down. */
  hier: [string, string, string];
  /** "L-165" for belts, the size label for conveyor. */
  exactSize: string;
  displayName: string;
  /** Preferred SKU code, e.g. TB-L-165-OPTI (may get a suffix if taken). */
  codeBase: string;
}

export type RawIdentity = Partial<Record<
  'family' | 'section' | 'size' | 'colour' | 'brand' | 'length' | 'width' | 'thickness', unknown>>;

/** Build a product identity from raw cell values. Returns an error string when required parts are missing. */
export function buildIdentity(type: ProductType, raw: RawIdentity): Identity | { error: string } {
  const family = cleanText(raw.family);
  const brand = cleanText(raw.brand);
  const missing: string[] = [];
  if (!family) missing.push('Product Family');
  if (!brand) missing.push('Make');

  if (type === 'CONVEYOR_BELT') {
    const colour = cleanText(raw.colour);
    const l = toNumber(raw.length);
    const w = toNumber(raw.width);
    const t = toNumber(raw.thickness);
    if (!colour) missing.push('Colour');
    if (l === null) missing.push('L');
    if (w === null) missing.push('W');
    if (missing.length) return { error: `Missing ${missing.join(', ')}` };

    const sizeLabel = [l, w, t].filter((n): n is number => n !== null).map(fmtNum).join(' X ');
    const meta = TYPE_META[type];
    return {
      type, family, section: null, colour, brand, sizeLabel,
      lengthMm: l, widthMm: w, thicknessMm: t,
      key: [type, family, colour, sizeLabel, brand].map(keyPart).join('|'),
      hier: [family, colour, sizeLabel],
      exactSize: sizeLabel,
      displayName: `${colour} ${sizeLabel} ${brand}`,
      codeBase: [meta.prefix, slug(family), slug(colour), slug(sizeLabel), slug(brand)].join('-'),
    };
  }

  const section = cleanText(raw.section);
  const sizeNum = toNumber(raw.size);
  const size = sizeNum !== null ? fmtNum(sizeNum) : cleanText(raw.size);
  if (!section) missing.push('Section');
  if (!size) missing.push('Size');
  if (missing.length) return { error: `Missing ${missing.join(', ')}` };

  const meta = TYPE_META[type];
  const exactSize = `${section}-${size}`;
  return {
    type, family, section, colour: null, brand, sizeLabel: size,
    lengthMm: null, widthMm: null, thicknessMm: null,
    key: [type, family, section, size, brand].map(keyPart).join('|'),
    hier: [family, section, size],
    exactSize,
    displayName: `${exactSize} ${brand}`,
    codeBase: [meta.prefix, slug(section), slug(size), slug(brand)].join('-'),
  };
}

export const isIdentityError = (x: Identity | { error: string }): x is { error: string } => 'error' in x;

/** Brand / family code used in the brands / product_families tables. */
export const toCode = (name: string): string =>
  name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

/**
 * Pick a unique SKU code. `taken` is every code already in use (DB + this run).
 * First choice is the readable base; on a clash with a *different* product it
 * appends the family, then a number.
 */
export function uniqueSkuCode(id: Identity, taken: Set<string>): string {
  const tryOrder = [id.codeBase, `${id.codeBase}-${slug(id.family)}`];
  for (const c of tryOrder) if (!taken.has(c)) return c;
  let n = 2;
  while (taken.has(`${id.codeBase}-${n}`)) n++;
  return `${id.codeBase}-${n}`;
}
