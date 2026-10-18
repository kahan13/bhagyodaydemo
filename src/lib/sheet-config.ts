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

export type ImportKind = 'SKU' | 'INVENTORY' | 'MSL';

export type FieldKey =
  | 'family' | 'section' | 'size' | 'colour' | 'brand'
  | 'length' | 'width' | 'thickness'
  | 'lot_type' | 'uom_mm' | 'qty' | 'location' | 'remarks' | 'msl';

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
  /** Headings of the 3 inventory panes. */
  levels: [string, string, string];
  /** Column headings of the last pane's list (stock is always shown after them). */
  leafColumns: [string, string];
}

export const PRODUCT_TYPES: ProductType[] = ['TIMING_BELT', 'V_BELT', 'CONVEYOR_BELT'];

export const TYPE_META: Record<ProductType, TypeMeta> = {
  TIMING_BELT: {
    label: 'Timing Belts', short: 'Timing', prefix: 'TB', unit: 'MM', usesLots: true,
    sheetHints: ['timing'],
    levels: ['Product Family', 'Section', 'Size · Make'],
    leafColumns: ['Size', 'Make'],
  },
  V_BELT: {
    label: 'V-Belts', short: 'V-Belt', prefix: 'VB', unit: 'PCS', usesLots: false,
    sheetHints: ['v belt', 'vbelt', 'v-belt'],
    levels: ['Product Family', 'Make', 'Section · Size'],
    leafColumns: ['Section', 'Size'],
  },
  CONVEYOR_BELT: {
    label: 'Conveyor Belts', short: 'Conveyor', prefix: 'CB', unit: 'PCS', usesLots: false,
    sheetHints: ['conveyor'],
    levels: ['Product Family', 'Colour', 'Size · Make'],
    leafColumns: ['Size', 'Make'],
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
  msl:      { key: 'msl',      label: 'MSL (min. stock)', aliases: ['msl', 'min stock', 'min stock level', 'minimum stock level', 'minimum stock', 'min'],
              hint: 'Optional — alert level. Timing belts: number of pieces; others: pieces' } as FieldDef,
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
export const SKU_FIELDS: Record<ProductType, FieldDef[]> = {
  TIMING_BELT: [...IDENTITY.TIMING_BELT, F.msl],
  V_BELT: [...IDENTITY.V_BELT, F.msl],
  CONVEYOR_BELT: [...IDENTITY.CONVEYOR_BELT, F.msl],
};

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
    F.location, F.remarks, F.msl,
  ],
  V_BELT: [
    ...IDENTITY.V_BELT,
    { key: 'qty', label: 'UOM (PCS)', required: true, aliases: ['uom (pcs)', 'uom pcs', 'qty', 'quantity'],
      hint: 'Pieces in stock' },
    F.location, F.remarks, F.msl,
  ],
  CONVEYOR_BELT: [
    ...IDENTITY.CONVEYOR_BELT,
    { key: 'qty', label: 'QTY', required: true, aliases: ['qty', 'quantity'], hint: 'Pieces in stock' },
    F.location, F.remarks, F.msl,
  ],
};

/** MSL-only import: identity columns (to find the product) + the MSL column. Nothing else is read. */
export const MSL_FIELDS: Record<ProductType, FieldDef[]> = {
  TIMING_BELT: [...IDENTITY.TIMING_BELT, { ...F.msl, required: true }],
  V_BELT: [...IDENTITY.V_BELT, { ...F.msl, required: true }],
  CONVEYOR_BELT: [...IDENTITY.CONVEYOR_BELT, { ...F.msl, required: true }],
};

export const fieldsFor = (kind: ImportKind, type: ProductType): FieldDef[] =>
  (kind === 'SKU' ? SKU_FIELDS : kind === 'MSL' ? MSL_FIELDS : INVENTORY_FIELDS)[type];

// ── Header matching ──────────────────────────────────────────────────────────

export const normHeader = (s: unknown): string =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Collapse stray spaces in a header ("MAKE " -> "MAKE"). Used by BOTH the browser and the server. */
export const cleanHeader = (h: unknown): string => String(h ?? '').replace(/\s+/g, ' ').trim();

/** Exact (normalised) match of sheet headers to fields — no fuzzy guessing. */
export function autoMap(headers: string[], fields: FieldDef[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of fields) {
    const wanted = new Set([f.label, ...f.aliases].map(normHeader));
    const hit = headers.find((h) => !used.has(h) && wanted.has(normHeader(h)));
    if (hit) { out[f.key] = hit; used.add(hit); }
  }
  // A sheet whose first header cell holds a family NAME instead of "PRODUCT FAMILY"
  // (e.g. the Bando "B" tab says CLASSICAL): the first column is the family column.
  const fam = fields.find((f) => f.key === 'family');
  if (fam && !out.family && headers.length && !used.has(headers[0])) out.family = headers[0];
  return out;
}

/** Work out the product type from a sheet's column headings (more reliable than the tab name). */
export function detectTypeFromHeaders(headers: string[]): ProductType | null {
  const n = headers.map(normHeader);
  if (n.some((h) => h.includes('sectionoftimingbelt') || h.startsWith('cutpcs') || h === 'uominmm')) return 'TIMING_BELT';
  if (n.some((h) => h.includes('sectionofvbelt'))) return 'V_BELT';
  if ((n.includes('colour') || n.includes('color')) && (n.includes('l') || n.includes('length'))) return 'CONVEYOR_BELT';
  return null;
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
  (s === UNSPECIFIED ? 'NA' : s).toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9.]+/g, '-').replace(/^-+|-+$/g, '');

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
  /** hier_l1 / l2 / l3 for the Inventory drill-down (V-belt: Family, Make, Size). */
  hier: [string, string, string];
  /** "L-165" for belts, the size label for conveyor. */
  exactSize: string;
  displayName: string;
  /** Preferred SKU code, e.g. TB-L-165-OPTI (may get a suffix if taken). */
  codeBase: string;
  /** Identity parts the sheet left blank (they were saved as UNSPECIFIED). Empty = complete. */
  missing: string[];
}

/** What a blank identity part is saved as, so the product can still be created and fixed later. */
export const UNSPECIFIED = 'UNSPECIFIED';

export type RawIdentity = Partial<Record<
  'family' | 'section' | 'size' | 'colour' | 'brand' | 'length' | 'width' | 'thickness', unknown>>;

/**
 * Build a product identity from raw cell values.
 * A blank part does NOT reject the row: it is saved as UNSPECIFIED and listed in `missing`,
 * so the product exists, is flagged in Product Master, and can be fixed there.
 * Only a row with no identity at all (every part blank) comes back as an error.
 */
export function buildIdentity(type: ProductType, raw: RawIdentity): Identity | { error: string } {
  const missing: string[] = [];
  const part = (v: unknown, label: string): string => {
    const t = cleanText(v);
    if (!t) { missing.push(label); return UNSPECIFIED; }
    return t;
  };
  const meta = TYPE_META[type];

  if (type === 'CONVEYOR_BELT') {
    const family = part(raw.family, 'Product Family');
    const colour = part(raw.colour, 'Colour');
    const brand = part(raw.brand, 'Make');
    const l = toNumber(raw.length), w = toNumber(raw.width), t = toNumber(raw.thickness);
    if (l === null) missing.push('L');
    if (w === null) missing.push('W');
    if (missing.length >= 5) return { error: 'No product details in this row' };

    const sizeLabel = [l, w, t].filter((n): n is number => n !== null).map(fmtNum).join(' X ') || UNSPECIFIED;
    return {
      type, family, section: null, colour, brand, sizeLabel,
      lengthMm: l, widthMm: w, thicknessMm: t,
      key: [type, family, colour, sizeLabel, brand].map(keyPart).join('|'),
      hier: [family, colour, sizeLabel],
      exactSize: sizeLabel,
      displayName: `${colour} ${sizeLabel} ${brand}`,
      codeBase: [meta.prefix, slug(family), slug(colour), slug(sizeLabel), slug(brand)].join('-'),
      missing,
    };
  }

  const family = part(raw.family, 'Product Family');
  const brand = part(raw.brand, 'Make');
  const section = part(raw.section, 'Section');
  const sizeNum = toNumber(raw.size);
  const sizeText = sizeNum !== null ? fmtNum(sizeNum) : cleanText(raw.size);
  if (!sizeText) missing.push('Size');
  const size = sizeText || UNSPECIFIED;
  if (missing.length >= 4) return { error: 'No product details in this row' };

  const exactSize = `${section}-${size}`;
  return {
    type, family, section, colour: null, brand, sizeLabel: size,
    lengthMm: null, widthMm: null, thicknessMm: null,
    key: [type, family, section, size, brand].map(keyPart).join('|'),
    // V-belts are browsed Family > Make > Section/Size; the others Family > Section > Size/Make.
    hier: type === 'V_BELT' ? [family, brand, size] : [family, section, size],
    exactSize,
    displayName: `${exactSize} ${brand}`,
    codeBase: [meta.prefix, slug(section), slug(size), slug(brand)].join('-'),
    missing,
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
