#!/usr/bin/env node
/**
 * Bhagyoday Belts — master data import pipeline
 * ---------------------------------------------------------------------------
 * Excel → validate → preview → commit → PostgreSQL
 *
 * The ONLY way products, brands, families, suppliers, users, opening stock and
 * history enter the system. Nothing about belts is written in the application
 * code, so swapping the demo workbook for the real one is one command.
 *
 *   node scripts/import-master-excel.mjs                       # validate only
 *   node scripts/import-master-excel.mjs --commit --with-history --create-auth-users
 *   node scripts/import-master-excel.mjs --file ./data/Real.xlsx --commit --with-history --replace
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const FILE = path.resolve(opt('file', './data/Bhagyoday_Belts_Demo_Master_Data.xlsx'));
const COMMIT = flag('commit');
const WITH_HISTORY = flag('with-history');
const REPLACE = flag('replace');
const CREATE_AUTH = flag('create-auth-users');
const DOMAIN = opt('email-domain', 'bhagyodaybelts.com');

for (const f of ['.env.local', '.env']) {
  const p = path.resolve(f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });

const errors = [];
const warnings = [];
const err = (sheet, row, msg) => errors.push({ sheet, row, msg });
const warn = (sheet, row, msg) => warnings.push({ sheet, row, msg });

const yes = (v) => String(v ?? '').trim().toUpperCase() === 'YES';
const num = (v, d = 0) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v));
const str = (v) => (v == null ? '' : String(v).trim());
const TYPE = { 'TIMING BELT': 'TIMING_BELT', TIMING_BELT: 'TIMING_BELT', 'V-BELT': 'V_BELT', V_BELT: 'V_BELT' };
const FORM = (v) => (str(v).toUpperCase().startsWith('OPEN') ? 'OPEN_ENDED' : 'ENDLESS');

const chunk = (rows, size = 500) => {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};

async function upsert(table, rows, conflict) {
  for (const part of chunk(rows)) {
    const { error } = await db.from(table).upsert(part, { onConflict: conflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

const banner = (t) => { console.log(`\n${t}`); console.log('-'.repeat(Math.max(t.length, 58))); };

/* ------------------------------------------------------------------- read */
if (!fs.existsSync(FILE)) { console.error(`Workbook not found: ${FILE}`); process.exit(1); }

// Read as a buffer: the SheetJS ESM build does not expose filesystem helpers.
const wb = XLSX.read(fs.readFileSync(FILE), { type: 'buffer', cellDates: false });
const sheet = (n) => (wb.Sheets[n] ? XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: '' }) : null);

for (const s of ['Brands', 'Product_Families', 'Units', 'Timing_Belts', 'V_Belts', 'Suppliers', 'Users']) {
  if (!wb.Sheets[s]) err('workbook', 0, `Sheet "${s}" is missing`);
}
if (errors.length) {
  banner('Import cannot start');
  errors.forEach((e) => console.log(`  ${e.sheet}: ${e.msg}`));
  process.exit(1);
}

const S = {
  brands: sheet('Brands') ?? [],
  families: sheet('Product_Families') ?? [],
  units: sheet('Units') ?? [],
  timing: sheet('Timing_Belts') ?? [],
  vbelts: sheet('V_Belts') ?? [],
  suppliers: sheet('Suppliers') ?? [],
  users: sheet('Users') ?? [],
  txns: sheet('Demo_Transactions') ?? sheet('Transactions') ?? [],
  audit: sheet('Audit_Log') ?? [],
};

banner(`Reading ${path.basename(FILE)}`);
Object.entries(S).forEach(([k, v]) => console.log(`  ${k.padEnd(11)} ${String(v.length).padStart(5)} rows`));

/* --------------------------------------------------------------- validate */
const unitCodes = new Set(S.units.map((r) => str(r.Unit_Code)).filter(Boolean));
const brandByCode = new Map(S.brands.map((r) => [str(r.Brand_Code), r]));
const supplierByCode = new Map(S.suppliers.map((r) => [str(r.Supplier_ID), r]));
const userByCode = new Map(S.users.map((r) => [str(r.User_ID), r]));
const famKey = (t, c) => `${t}::${c}`;
const families = new Map();

S.families.forEach((r, i) => {
  const type = TYPE[str(r.Product_Type).toUpperCase()];
  if (!type) return err('Product_Families', i + 2, `Unknown Product_Type "${r.Product_Type}"`);
  const code = str(r.Level_1_Value);
  if (!code) return err('Product_Families', i + 2, 'Level_1_Value is blank');
  families.set(famKey(type, code), r);
});
if (!unitCodes.size) err('Units', 0, 'No units defined');

const skuRows = [];
const seen = new Set();

const pushSku = (row) => { skuRows.push(row); seen.add(row.sku_code); };

S.timing.forEach((r, i) => {
  const n = i + 2;
  const sku = str(r.SKU);
  if (!sku) return err('Timing_Belts', n, 'SKU is blank');
  if (seen.has(sku)) return err('Timing_Belts', n, `Duplicate SKU ${sku}`);

  const fam = str(r.Family_Code);
  const brand = str(r.Brand_Code);
  if (!families.has(famKey('TIMING_BELT', fam))) err('Timing_Belts', n, `${sku}: family "${fam}" not in Product_Families`);
  if (!brandByCode.has(brand)) err('Timing_Belts', n, `${sku}: brand "${brand}" not in Brands`);
  if (!unitCodes.has(str(r.Unit))) err('Timing_Belts', n, `${sku}: unit "${r.Unit}" not in Units`);
  if (num(r.Opening_Stock) < 0) err('Timing_Belts', n, `${sku}: opening stock is negative`);
  if (str(r.Default_Supplier) && !supplierByCode.has(str(r.Default_Supplier)))
    warn('Timing_Belts', n, `${sku}: supplier "${r.Default_Supplier}" not found`);

  const size = str(r.Exact_Size);
  pushSku({
    sku_code: sku, product_type: 'TIMING_BELT', family_code: fam, brand_code: brand,
    exact_size: size, display_name: str(r.Display_Name) || `${size} ${str(r.Brand)}`,
    hier_l1: fam, hier_l2: size, hier_l3: str(r.Brand),   // family -> size -> brand
    search_text: `${size} ${str(r.Brand)} ${fam} ${sku}`.toLowerCase(),
    belt_form: FORM(r.Belt_Form), construction: null, standard: str(r.Standard) || null,
    pitch_mm: r.Pitch_mm === '' ? null : num(r.Pitch_mm),
    pitch_length_mm: r.Pitch_Length_mm === '' ? null : num(r.Pitch_Length_mm),
    width_mm: r.Width_mm === '' ? null : num(r.Width_mm),
    teeth: r.Teeth === '' ? null : Math.round(num(r.Teeth)),
    nominal_length: null, length_designation: null,
    unit_code: str(r.Unit), opening_stock: num(r.Opening_Stock),
    min_stock_level: num(r.Min_Stock_Level), supplier_moq: num(r.Supplier_MOQ),
    reorder_quantity: num(r.Reorder_Quantity), supplier_code: str(r.Default_Supplier),
    rack_location: str(r.Rack_Location) || null, is_active: yes(r.Active),
  });
});

S.vbelts.forEach((r, i) => {
  const n = i + 2;
  const sku = str(r.SKU);
  if (!sku) return err('V_Belts', n, 'SKU is blank');
  if (seen.has(sku)) return err('V_Belts', n, `Duplicate SKU ${sku}`);

  const profile = str(r.Profile);
  const brand = str(r.Brand_Code);
  if (!families.has(famKey('V_BELT', profile))) err('V_Belts', n, `${sku}: profile "${profile}" not in Product_Families`);
  if (!brandByCode.has(brand)) err('V_Belts', n, `${sku}: brand "${brand}" not in Brands`);
  if (!unitCodes.has(str(r.Unit))) err('V_Belts', n, `${sku}: unit "${r.Unit}" not in Units`);
  if (num(r.Opening_Stock) < 0) err('V_Belts', n, `${sku}: opening stock is negative`);

  const size = str(r.Exact_Size);
  pushSku({
    sku_code: sku, product_type: 'V_BELT', family_code: profile, brand_code: brand,
    exact_size: size, display_name: str(r.Display_Name) || `${size} ${str(r.Brand)}`,
    hier_l1: str(r.Brand), hier_l2: profile, hier_l3: size,   // brand -> profile -> size
    search_text: `${size} ${str(r.Brand)} ${profile} ${sku}`.toLowerCase(),
    belt_form: 'ENDLESS', construction: str(r.Construction) || null, standard: null,
    pitch_mm: null, pitch_length_mm: null, width_mm: null, teeth: null,
    nominal_length: r.Nominal_Length === '' ? null : num(r.Nominal_Length),
    length_designation: str(r.Length_Designation) || null,
    unit_code: str(r.Unit), opening_stock: num(r.Opening_Stock),
    min_stock_level: num(r.Min_Stock_Level), supplier_moq: num(r.Supplier_MOQ),
    reorder_quantity: num(r.Reorder_Quantity), supplier_code: str(r.Default_Supplier),
    rack_location: str(r.Rack_Location) || null, is_active: yes(r.Active),
  });
});

const txnRows = [];
if (WITH_HISTORY) {
  const unitOf = new Map(skuRows.map((s) => [s.sku_code, s.unit_code]));
  S.txns.forEach((r, i) => {
    const n = i + 2;
    const sku = str(r.SKU);
    if (!seen.has(sku)) return err('Demo_Transactions', n, `Unknown SKU ${sku}`);
    const type = str(r.Txn_Type).toUpperCase();
    if (!['INWARD', 'OUTWARD', 'ADJUSTMENT'].includes(type))
      return err('Demo_Transactions', n, `Unknown type "${r.Txn_Type}"`);
    if (str(r.Unit) && str(r.Unit) !== unitOf.get(sku))
      err('Demo_Transactions', n, `${sku}: unit ${r.Unit} does not match SKU unit ${unitOf.get(sku)}`);
    if (!str(r.Timestamp_IST)) err('Demo_Transactions', n, 'Timestamp_IST is blank');
    if (str(r.User_ID) && !userByCode.has(str(r.User_ID)))
      warn('Demo_Transactions', n, `User ${r.User_ID} not in Users sheet`);

    txnRows.push({
      excel_id: str(r.Transaction_ID), sku_code: sku, txn_type: type,
      txn_mode: str(r.Txn_Mode).toUpperCase() === 'REVERSAL' ? 'REVERSAL' : 'NORMAL',
      quantity: num(r.Quantity), occurred_at: str(r.Timestamp_IST),
      user_code: str(r.User_ID), user_name: str(r.User_Name),
      channel: str(r.Channel) || 'IMPORT', reference: str(r.Reference) || null,
      notes: str(r.Notes) || null, reversal_of_excel: str(r.Reversal_Of_Txn_ID) || null, row: n,
    });
  });
  txnRows.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
}

// Replay the ledger to prove it never goes negative.
const stockAfter = new Map(skuRows.map((s) => [s.sku_code, s.opening_stock]));
for (const t of txnRows) {
  const prev = stockAfter.get(t.sku_code) ?? 0;
  const next = t.txn_type === 'INWARD' ? prev + t.quantity
    : t.txn_type === 'OUTWARD' ? prev - t.quantity : prev + t.quantity;
  if (next < 0) err('Demo_Transactions', t.row, `${t.sku_code}: history goes negative (${prev} -> ${next})`);
  t.previous_stock = prev;
  t.new_stock = next;
  stockAfter.set(t.sku_code, next);
}

/* ---------------------------------------------------------------- preview */
banner('Validation');
if (errors.length) {
  console.log(`  ${errors.length} error(s) — nothing will be written:`);
  errors.slice(0, 40).forEach((e) => console.log(`   x [${e.sheet} row ${e.row}] ${e.msg}`));
  if (errors.length > 40) console.log(`   … and ${errors.length - 40} more`);
} else {
  console.log('  No errors.');
}
if (warnings.length) {
  console.log(`  ${warnings.length} warning(s):`);
  warnings.slice(0, 12).forEach((w) => console.log(`   ! [${w.sheet} row ${w.row}] ${w.msg}`));
}

const low = skuRows.filter((s) => (stockAfter.get(s.sku_code) ?? 0) < s.min_stock_level).length;
banner('Preview');
console.log(`  Brands             ${S.brands.length}`);
console.log(`  Families/profiles  ${families.size}`);
console.log(`  Units              ${unitCodes.size}`);
console.log(`  Suppliers          ${S.suppliers.length}`);
console.log(`  Users              ${S.users.length}`);
console.log(`  SKUs               ${skuRows.length}  (timing ${S.timing.length}, v-belt ${S.vbelts.length})`);
console.log(`  Movements          ${WITH_HISTORY ? txnRows.length : '0  (use --with-history)'}`);
console.log(`  Below minimum after import: ${low} SKUs`);

if (errors.length) process.exit(1);
if (!COMMIT) {
  banner('Dry run finished');
  console.log('  Nothing was written. Re-run with --commit to import.');
  process.exit(0);
}

/* ----------------------------------------------------------------- commit */
banner('Importing');

if (REPLACE) {
  console.log('  Clearing movement history (controlled purge)…');
  const { error } = await db.rpc('purge_transactional_data');
  if (error) throw new Error(`purge: ${error.message}`);
}

await upsert('units', S.units.map((r) => ({
  code: str(r.Unit_Code), name: str(r.Unit_Name), decimals: num(r.Decimals_Allowed),
  used_for: str(r.Used_For), is_active: yes(r.Active),
})), 'code');
console.log('  units ✓');

await upsert('brands', S.brands.map((r) => ({
  code: str(r.Brand_Code), name: str(r.Brand_Name), country_origin: str(r.Country_Origin),
  has_timing_belts: yes(r.Timing_Belts), has_v_belts: yes(r.V_Belts), is_active: yes(r.Active),
})), 'code');
const { data: brandRows } = await db.from('brands').select('id, code');
const brandId = new Map(brandRows.map((b) => [b.code, b.id]));
console.log('  brands ✓');

await upsert('product_families', S.families.map((r, i) => ({
  product_type: TYPE[str(r.Product_Type).toUpperCase()],
  code: str(r.Level_1_Value), name: str(r.Family_Name),
  standard: str(r.Standard) || null,
  pitch_mm: r.Pitch_mm === '' ? null : num(r.Pitch_mm),
  belt_form: FORM(r.Belt_Form), default_unit: str(r.Default_Unit) || null,
  size_designation: str(r.Size_Designation) || null,
  profile_group: str(r.Profile_Group) || null,
  sort_order: i + 1, is_active: yes(r.Active),
})), 'product_type,code');
const { data: famRows } = await db.from('product_families').select('id, product_type, code');
const famId = new Map(famRows.map((f) => [famKey(f.product_type, f.code), f.id]));
console.log('  families ✓');

await upsert('suppliers', S.suppliers.map((r) => ({
  supplier_code: str(r.Supplier_ID), name: str(r.Supplier_Name), city: str(r.City),
  state: str(r.State), gstin: str(r.GSTIN_Demo || r.GSTIN), contact_person: str(r.Contact_Person),
  phone: str(r.Phone), email: str(r.Email), brands_supplied: str(r.Brands_Supplied),
  lead_time_days: num(r.Lead_Time_Days, null), payment_terms: str(r.Payment_Terms),
  is_active: yes(r.Active),
})), 'supplier_code');
const { data: supRows } = await db.from('suppliers').select('id, supplier_code');
const supId = new Map(supRows.map((s) => [s.supplier_code, s.id]));
console.log('  suppliers ✓');

// Deliberately not imported as accounts. Supabase Auth is the only register of
// who exists; a spreadsheet row cannot sign in and should not look like someone
// who can. Movements keep the spoken name in user_name, so history is unchanged.
const { data: userRows } = await db.from('app_users').select('id, user_code, email');
const userId = new Map((userRows ?? []).filter((u) => u.user_code).map((u) => [u.user_code, u.id]));
console.log(`  users — skipped (${S.users.length} name(s) kept on history only)`);

await upsert('skus', skuRows.map((s) => ({
  sku_code: s.sku_code, product_type: s.product_type,
  family_id: famId.get(famKey(s.product_type, s.family_code)),
  brand_id: brandId.get(s.brand_code),
  exact_size: s.exact_size, display_name: s.display_name,
  hier_l1: s.hier_l1, hier_l2: s.hier_l2, hier_l3: s.hier_l3, search_text: s.search_text,
  belt_form: s.belt_form, construction: s.construction, standard: s.standard,
  pitch_mm: s.pitch_mm, pitch_length_mm: s.pitch_length_mm, width_mm: s.width_mm,
  teeth: s.teeth, nominal_length: s.nominal_length, length_designation: s.length_designation,
  unit_code: s.unit_code, opening_stock: s.opening_stock, current_stock: s.opening_stock,
  min_stock_level: s.min_stock_level, supplier_moq: s.supplier_moq,
  reorder_quantity: s.reorder_quantity, default_supplier_id: supId.get(s.supplier_code) ?? null,
  rack_location: s.rack_location, is_active: s.is_active, updated_at: new Date().toISOString(),
})), 'sku_code');
console.log(`  skus ✓ (${skuRows.length})`);

if (REPLACE) {
  const keep = new Set(skuRows.map((s) => s.sku_code));
  const { data: existing } = await db.from('skus').select('sku_code').eq('is_active', true);
  const stale = (existing ?? []).map((s) => s.sku_code).filter((c) => !keep.has(c));
  if (stale.length) {
    await db.from('skus').update({ is_active: false }).in('sku_code', stale);
    console.log(`  ${stale.length} SKU(s) absent from the new file were deactivated (never deleted)`);
  }
}

if (WITH_HISTORY && txnRows.length) {
  const { data: skuIdRows } = await db.from('skus').select('id, sku_code');
  const skuId = new Map(skuIdRows.map((s) => [s.sku_code, s.id]));
  const unitOf = new Map(skuRows.map((s) => [s.sku_code, s.unit_code]));

  let n = 0;
  const payload = txnRows.map((t) => {
    n += 1;
    const ts = t.occurred_at.length <= 10 ? `${t.occurred_at}T00:00:00+05:30` : t.occurred_at;
    return {
      txn_no: `TXN-${ts.slice(0, 4)}${ts.slice(5, 7)}-${String(n).padStart(5, '0')}`,
      excel_id: t.excel_id, reversal_of_excel: t.reversal_of_excel,
      sku_id: skuId.get(t.sku_code), txn_type: t.txn_type, txn_mode: t.txn_mode,
      quantity: t.quantity, unit_code: unitOf.get(t.sku_code),
      previous_stock: t.previous_stock, new_stock: t.new_stock, occurred_at: ts,
      user_id: userId.get(t.user_code) ?? null, user_name: t.user_name || 'Imported',
      channel: ['WEB', 'MOBILE_PWA', 'MOBILE_VOICE', 'IMPORT', 'SYSTEM'].includes(t.channel) ? t.channel : 'IMPORT',
      reference: t.reference, notes: t.notes,
    };
  });

  for (const part of chunk(payload.map(({ excel_id, reversal_of_excel, ...rest }) => rest), 400)) {
    const { error } = await db.from('inventory_movements').insert(part);
    if (error) throw new Error(`movements: ${error.message}`);
  }
  console.log(`  movements ✓ (${payload.length})`);

  const byExcel = new Map(payload.map((p) => [p.excel_id, p.txn_no]));
  const { data: inserted } = await db.from('inventory_movements').select('id, txn_no');
  const idByNo = new Map(inserted.map((m) => [m.txn_no, m.id]));
  const links = payload.filter((p) => p.reversal_of_excel && byExcel.has(p.reversal_of_excel));
  for (const l of links) {
    const revId = idByNo.get(l.txn_no);
    const origId = idByNo.get(byExcel.get(l.reversal_of_excel));
    if (!revId || !origId) continue;
    await db.from('inventory_movements').update({ reversal_of: origId }).eq('id', revId);
    await db.from('inventory_movements').update({ is_reversed: true, reversed_by: revId }).eq('id', origId);
  }
  console.log(`  reversal links ✓ (${links.length})`);
  await db.rpc('sync_movement_seq');
}

if (WITH_HISTORY && S.audit.length) {
  const rows = S.audit.map((r) => ({
    occurred_at: str(r.Timestamp_IST), user_id: userId.get(str(r.User_ID)) ?? null,
    user_name: str(r.User_Name), role_code: str(r.Role) || null, action: str(r.Action),
    entity_type: str(r.Entity_Type), entity_reference: str(r.Entity_Reference),
    old_value: str(r.Old_Value), new_value: str(r.New_Value),
    channel: str(r.Channel) || 'WEB', ip_address: str(r.IP_Address) || null,
    description: str(r.Description),
  }));
  for (const part of chunk(rows)) {
    const { error } = await db.from('audit_logs').insert(part);
    if (error) throw new Error(`audit_logs: ${error.message}`);
  }
  console.log(`  activity trail ✓ (${rows.length})`);
}

const { data: rebuilt, error: rebuildErr } = await db.rpc('rebuild_stock_cache');
if (rebuildErr) throw new Error(`rebuild_stock_cache: ${rebuildErr.message}`);
console.log(`  stock cache rebuilt (${rebuilt} SKU(s) updated)`);

const { data: check } = await db.from('skus').select('sku_code, current_stock');
let mismatch = 0;
for (const row of check) {
  const expected = stockAfter.get(row.sku_code);
  if (expected !== undefined && Math.abs(Number(row.current_stock) - expected) > 0.001) mismatch += 1;
}
console.log(`  reconciliation: ${mismatch === 0 ? 'stock matches the ledger exactly' : `${mismatch} MISMATCH(ES)`}`);

if (CREATE_AUTH) {
  console.log('  --create-auth-users no longer applies: accounts are created in Supabase');
}

await db.from('import_batches').insert({
  file_name: path.basename(FILE), imported_by: 'import-master-excel.mjs',
  mode: REPLACE ? 'REPLACE' : WITH_HISTORY ? 'MASTER_WITH_HISTORY' : 'MASTER_ONLY',
  counts: {
    brands: S.brands.length, families: families.size, suppliers: S.suppliers.length,
    users: S.users.length, skus: skuRows.length, movements: WITH_HISTORY ? txnRows.length : 0,
  },
  warnings: warnings.slice(0, 200), notes: `Imported from ${path.basename(FILE)}`,
});

banner('Done');
console.log('  Sign in at http://localhost:3000 — stock in the UI is derived from the ledger.');
