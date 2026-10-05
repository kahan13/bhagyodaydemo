/**
 * Server-side helpers shared by the Products import and the Inventory import.
 * (Pure parsing/identity logic lives in sheet-config.ts so the browser can use it too.)
 */

import * as XLSX from 'xlsx';
import type { ProductType } from '@/lib/types';
import {
  TYPE_META, buildIdentity, isIdentityError, toCode, uniqueSkuCode,
  type FieldDef, type Identity, type RawIdentity,
} from '@/lib/sheet-config';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Svc = any; // the service-role Supabase client

export const PREVIEW_LIMIT = 12;

/** Read one sheet into row objects keyed by header text. */
export async function readSheet(file: File, sheetName: string | null) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const name = sheetName && wb.Sheets[sheetName] ? sheetName : wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[name], { defval: '' });
  return rows;
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
}

/** Every SKU (all types — sku_code is unique across types). */
export async function loadAllSkus(svc: Svc): Promise<ExistingSku[]> {
  return fetchAll<ExistingSku>(() =>
    svc.from('skus')
      .select('id,sku_code,identity_key,product_type,current_stock,opening_stock,physical_prod_stock')
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
    created_via: createdVia,
    unit_code: meta.unit,
    opening_stock: 0,
    current_stock: 0,
    min_stock_level: 0,
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
  const needsMigration = /identity_key|created_via|type_history_count|wipe_catalog_type|wipe_inventory_type|section|schema cache|does not exist|could not find/i.test(raw);
  const message = needsMigration
    ? `${raw} — the database is missing the latest changes. Run supabase/migrations/018_sheet_fields.sql in the Supabase SQL Editor, then try again.`
    : raw;
  return Response.json({ error: message }, { status: 500 });
}
