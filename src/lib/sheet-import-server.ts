/**
 * Server-side helpers shared by the Products import and the Inventory import.
 * (Pure parsing/identity logic lives in sheet-config.ts so the browser can use it too.)
 */

import * as XLSX from 'xlsx';
import type { ProductType } from '@/lib/types';
import {
  PRODUCT_TYPES, TYPE_META, buildIdentity, isIdentityError, toCode, toNumber, uniqueSkuCode,
  type FieldDef, type Identity, type RawIdentity,
} from '@/lib/sheet-config';
import { readWorkbook, readWorksheet, type SheetRow } from '@/lib/sheet-read';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Svc = any; // the service-role Supabase client

export const PREVIEW_LIMIT = 12;

/** One sheet the person ticked on the import screen. */
export interface SheetCfg { name: string; type: ProductType; mapping: Record<string, string> }

/** One sheet, read and ready to plan. `filled` = row number -> parts copied from the row above. */
export interface LoadedSheet extends SheetCfg { rows: SheetRow[]; filled: Map<number, string[]> }

/**
 * Read the `sheets` field of an import request. Also accepts the old single-sheet fields
 * (sheet / productType / mapping) so nothing that still posts them breaks.
 */
export function parseSheetCfgs(fd: FormData): { cfgs: SheetCfg[]; error?: string } {
  let cfgs: SheetCfg[] = [];
  const raw = fd.get('sheets');
  try {
    if (typeof raw === 'string' && raw) cfgs = JSON.parse(raw) as SheetCfg[];
    else {
      cfgs = [{
        name: (fd.get('sheet') as string) || '',
        type: fd.get('productType') as ProductType,
        mapping: JSON.parse((fd.get('mapping') as string) || '{}'),
      }];
    }
  } catch { return { cfgs: [], error: 'The sheet list could not be read.' }; }
  if (!Array.isArray(cfgs) || !cfgs.length) return { cfgs: [], error: 'Tick at least one sheet to import.' };
  for (const c of cfgs) {
    if (!PRODUCT_TYPES.includes(c.type)) return { cfgs: [], error: `Sheet "${c.name}": unknown product type.` };
  }
  return { cfgs };
}

/** Parts that are carried down when left blank (merged / "same as above" cells). */
const FILL_DOWN: { key: string; label: string }[] = [
  { key: 'family', label: 'Product Family' }, { key: 'brand', label: 'Make' },
  { key: 'section', label: 'Section' }, { key: 'colour', label: 'Colour' },
];

export async function loadSheets(file: File, cfgs: SheetCfg[]): Promise<LoadedSheet[]> {
  const wb = readWorkbook(await file.arrayBuffer());
  return cfgs.map((cfg) => {
    const { rows } = readWorksheet(wb, cfg.name);
    const filled = new Map<number, string[]>();
    const last: Record<string, unknown> = {};
    const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
    const groupCols = ['family', 'brand'].map((k) => cfg.mapping[k]).filter(Boolean);
    const sizeCols = ['size', 'length'].map((k) => cfg.mapping[k]).filter(Boolean);
    for (const row of rows) {
      // A "continuation" row (merged / same-as-above cells): Family AND Make are both blank but the
      // row has a size. Only then are blanks copied down — a lone blank Make or Section is NOT
      // guessed, it is imported as UNSPECIFIED and flagged for the person to fix.
      const continuation = groupCols.length > 0 && groupCols.every((c) => blank(row[c])) && sizeCols.some((c) => !blank(row[c]));
      for (const f of FILL_DOWN) {
        const col = cfg.mapping[f.key];
        if (!col) continue;
        if (blank(row[col])) {
          if (continuation && last[f.key] !== undefined) {
            row[col] = last[f.key];
            const list = filled.get(row.__row) ?? [];
            list.push(f.label);
            filled.set(row.__row, list);
          }
        } else {
          last[f.key] = row[col];
        }
      }
    }
    return { ...cfg, rows, filled };
  });
}

/** Does this row hold anything at all in the mapped columns? */
export const rowHasData = (mapping: Record<string, string>, row: Record<string, unknown>): boolean =>
  Object.values(mapping).some((col) => String(row[col] ?? '').trim() !== '');

/** MSL cell -> number (timing belts count pieces, so whole numbers). null = blank / unreadable. */
export function readMsl(mapping: Record<string, string>, row: Record<string, unknown>, type: ProductType): number | null {
  const n = toNumber(cellOf(mapping, row, 'msl'));
  if (n === null || n < 0) return null;
  return TYPE_META[type].usesLots ? Math.round(n) : n;
}

/** Page through a table (Supabase returns max 1000 rows per request). */
export async function fetchAll<T = any>(
  build: () => any, // returns a fresh query builder each call
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export const cellOf = (mapping: Record<string, string>, row: Record<string, unknown>, key: string): unknown =>
  mapping[key] ? row[mapping[key]] : undefined;

export function rawIdentityOf(mapping: Record<string, string>, row: Record<string, unknown>): RawIdentity {
  return {
    family: cellOf(mapping, row, 'family'),
    section: cellOf(mapping, row, 'section'),
    size: cellOf(mapping, row, 'size'),
    colour: cellOf(mapping, row, 'colour'),
    brand: cellOf(mapping, row, 'brand'),
    length: cellOf(mapping, row, 'length'),
    width: cellOf(mapping, row, 'width'),
    thickness: cellOf(mapping, row, 'thickness'),
  };
}

/** Which required fields have no column mapped at all? */
export function unmappedRequired(fields: FieldDef[], mapping: Record<string, string>): string[] {
  return fields.filter((f) => f.required && !mapping[f.key]).map((f) => f.label);
}

export interface ExistingSku {
  id: string;
  sku_code: string;
  identity_key: string | null;
  product_type: string;
  current_stock: number;
  opening_stock: number;
  physical_prod_stock: number;
  min_stock_level: number;
}

/** Every SKU (all types — sku_code is unique across types). */
export async function loadAllSkus(svc: Svc): Promise<ExistingSku[]> {
  return fetchAll<ExistingSku>(() =>
    svc.from('skus')
      .select('id,sku_code,identity_key,product_type,current_stock,opening_stock,physical_prod_stock,min_stock_level')
      .order('id'));
}

export async function historyCount(svc: Svc, type: ProductType): Promise<number> {
  const { data, error } = await svc.rpc('type_history_count', { p_type: type });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

/** Existing brand / family names so the preview can say which are new. */
export async function loadBrandFamilyNames(svc: Svc, type: ProductType) {
  const brands = await fetchAll<{ code: string; name: string }>(() =>
    svc.from('brands').select('code,name').order('code'));
  const families = await fetchAll<{ code: string; name: string }>(() =>
    svc.from('product_families').select('code,name').eq('product_type', type).order('code'));
  return {
    brandCodes: new Set(brands.map((b) => b.code)),
    familyCodes: new Set(families.map((f) => f.code)),
  };
}

/** Create any missing brands / families, return name -> id maps. */
export async function ensureBrandsAndFamilies(
  svc: Svc, type: ProductType, ids: Identity[],
): Promise<{ brandId: Map<string, string>; familyId: Map<string, string> }> {
  const brandId = new Map<string, string>();
  const familyId = new Map<string, string>();

  const brandNames = [...new Set(ids.map((i) => i.brand))];
  for (const name of brandNames) {
    const code = toCode(name);
    const { data, error } = await svc.from('brands')
      .upsert({ code, name, is_active: true }, { onConflict: 'code' })
      .select('id').single();
    if (error || !data) throw new Error(`Brand "${name}": ${error?.message ?? 'could not be saved'}`);
    brandId.set(name, data.id);
  }

  const familyNames = [...new Set(ids.map((i) => i.family))];
  for (const name of familyNames) {
    const code = toCode(name);
    const { data, error } = await svc.from('product_families')
      .upsert({ product_type: type, code, name }, { onConflict: 'product_type,code' })
      .select('id').single();
    if (error || !data) throw new Error(`Product family "${name}": ${error?.message ?? 'could not be saved'}`);
    familyId.set(name, data.id);
  }
  return { brandId, familyId };
}

/** The columns of a brand-new SKU row, from an identity. Stock starts at 0. */
export function newSkuRow(
  id: Identity, skuCode: string, familyId: string, brandId: string,
  createdVia: 'SKU_IMPORT' | 'INVENTORY_IMPORT' | 'MANUAL',
  msl: number | null = null,
) {
  const meta = TYPE_META[id.type];
  return {
    sku_code: skuCode,
    product_type: id.type,
    family_id: familyId,
    brand_id: brandId,
    exact_size: id.exactSize,
    display_name: id.displayName,
    hier_l1: id.hier[0],
    hier_l2: id.hier[1],
    hier_l3: id.hier[2],
    search_text: `${skuCode} ${id.family} ${id.section ?? ''} ${id.colour ?? ''} ${id.sizeLabel} ${id.exactSize} ${id.brand}`
      .toLowerCase().replace(/\s+/g, ' ').trim(),
    section: id.section,
    colour: id.colour,
    length_mm: id.lengthMm,
    width_mm: id.widthMm,
    thickness_mm: id.thicknessMm,
    identity_key: id.key,
    missing_fields: id.missing,
    created_via: createdVia,
    unit_code: meta.unit,
    opening_stock: 0,
    current_stock: 0,
    min_stock_level: msl ?? 0,
    supplier_moq: 0,
    reorder_quantity: 0,
    is_active: true,
  };
}

/** Insert SKUs in chunks; if a chunk fails, retry row by row to pinpoint the culprit. */
export async function insertSkus(
  svc: Svc, rows: ReturnType<typeof newSkuRow>[],
): Promise<{ idByCode: Map<string, string>; errors: { skuCode: string; message: string }[] }> {
  const idByCode = new Map<string, string>();
  const errors: { skuCode: string; message: string }[] = [];
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { data, error } = await svc.from('skus').insert(chunk).select('id,sku_code');
    if (!error && data) {
      for (const r of data) idByCode.set(r.sku_code, r.id);
      continue;
    }
    for (const row of chunk) {
      const one = await svc.from('skus').insert(row).select('id,sku_code').single();
      if (one.error || !one.data) errors.push({ skuCode: row.sku_code, message: one.error?.message ?? 'insert failed' });
      else idByCode.set(one.data.sku_code, one.data.id);
    }
  }
  return { idByCode, errors };
}

export { buildIdentity, isIdentityError, uniqueSkuCode };


/**
 * Turn any thrown error into a readable JSON response instead of an empty 500.
 * Redirects thrown by requirePermission() are re-thrown untouched.
 */
export function importErrorResponse(e: unknown): Response {
  const digest = (e as { digest?: string } | null)?.digest;
  if (typeof digest === 'string' && digest.startsWith('NEXT_')) throw e;
  const raw = e instanceof Error ? e.message : String(e);
  const needsMigration = /identity_key|created_via|type_history_count|wipe_catalog_type|wipe_inventory_type|section|missing_fields|schema cache|does not exist|could not find/i.test(raw);
  const message = needsMigration
    ? `${raw} — the database is missing the latest changes. Run the newest supabase/*.sql files (up to 031) in the Supabase SQL Editor, then try again.`
    : raw;
  return Response.json({ error: message }, { status: 500 });
}
