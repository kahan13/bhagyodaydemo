# Bhagyoday Belts — Inventory Management System

Next.js (App Router) + Supabase PostgreSQL. Deploys to Vercel. No Docker, no server to maintain.

---

## The rule this build is designed around

**No product data lives in the application code.** Brands, families, profiles, sizes, units,
opening stock and history all arrive through `scripts/import-master-excel.mjs`. React reads
`hier_l1 / hier_l2 / hier_l3` off each row and renders whatever tree the data describes:

| Product type | Level 1 | Level 2 | Level 3 |
|---|---|---|---|
| Timing belts | Family (HTD8M, AT10, L…) | Exact size (1200-8M-30) | Brand |
| V-belts | Brand | Profile (A, SPB, XPZ…) | Exact size (B-42) |

When Bhagyoday hands over the real workbook, you run one command. Nothing in `src/` changes.

---

## 1. Create the Supabase project

1. supabase.com → New project (region: Mumbai / ap-south-1).
2. SQL Editor → paste **`supabase/migrations/001_schema_and_engine.sql`** → Run.
3. SQL Editor → paste **`supabase/migrations/002_rbac_rls_seed.sql`** → Run.
4. Project Settings → API: copy the URL, the `anon` key and the `service_role` key.

## 2. Configure the app

```powershell
copy env.example .env.local     # then fill in the three keys
npm install
```

## 3. Load the master data

```powershell
npm run import:validate    # reads the workbook, validates, prints a preview, writes nothing
npm run import:demo        # commits masters + SKUs + history + creates sign-in accounts
```

The validator checks referential integrity (every brand, family, unit and supplier a SKU points
at must exist), duplicate SKUs, negative stock, unit mismatches between a movement and its SKU,
and replays the whole ledger to prove it never goes below zero. Any error stops the import
before a single row is written.

Sign in with any username from the Users sheet plus the password in `DEMO_USER_PASSWORD`:

| Email | Role |
|---|---|
| `nikhil.jain@bhagyodaybelts.local` | Super Admin |
| `rahul.shah@bhagyodaybelts.local` | Manager |
| `amit.p@bhagyodaybelts.local` | Inventory Operator |
| `priya.d@bhagyodaybelts.local` | Viewer |

## 4. Run it

```powershell
npm run dev     # http://localhost:3000
```

## 5. Deploy

Push to GitHub → import the repo on Vercel → add the same environment variables →
deploy. The client opens one URL and signs in. Nothing else to operate.

---

## Replacing the demo data with the real master

```powershell
node scripts/import-master-excel.mjs --file ./data/Bhagyoday_Real_Master.xlsx
node scripts/import-master-excel.mjs --file ./data/Bhagyoday_Real_Master.xlsx --commit --with-history --replace
```

`--replace` clears the demo movement history through the controlled purge routine and
deactivates SKUs that are absent from the new file. It never deletes a SKU, so old
transactions keep pointing at something real.

Then flip the banner off:

```sql
update app_settings
   set value = jsonb_build_object('status','LIVE','note','Bhagyoday Belts master data')
 where key = 'data_source';
```

---

## How stock works

Stock is never typed in. It is the result of movements:

```
opening stock + inward − outward ± adjustment = current stock
```

* `record_movement()` locks the SKU row, checks the caller's permission, enforces the SKU's
  unit, refuses to go below zero unless an admin enables it in settings, writes
  previous/new stock, the timestamp, the user and the device, and logs the audit entry —
  all in one transaction.
* `reverse_movement()` is the only correction path. The original row is untouched; a linked
  opposite entry is created. There is no delete endpoint, and the database has a trigger that
  refuses deletes on `inventory_movements` outright.
* `reconcile_stock()` recomputes every SKU from the ledger and returns anything that disagrees.
  It should always return zero rows.

## Roles

| | Super Admin | Manager | Operator | Viewer |
|---|---|---|---|---|
| See stock and history | ✓ | ✓ | ✓ | ✓ |
| Record inward / outward | ✓ | ✓ | ✓ | — |
| Adjust stock | ✓ | ✓ | — | — |
| Reverse a transaction | ✓ | ✓ | — | — |
| Export reports | ✓ | ✓ | — | — |
| Manage users and settings | ✓ | — | — | — |
| Full activity trail (all users, all devices) | ✓ | — | — | — |

Permissions are enforced inside the database functions and by row level security, not by
hiding buttons. An operator who calls the API directly still gets refused.

---

## File map

```
bhagyoday-belts-ims/
├─ data/Bhagyoday_Belts_Demo_Master_Data.xlsx
├─ supabase/migrations/001_schema_and_engine.sql
├─ supabase/migrations/002_rbac_rls_seed.sql
├─ scripts/import-master-excel.mjs
└─ src/
   ├─ middleware.ts
   ├─ lib/{supabase,auth,types}.ts
   ├─ app/
   │  ├─ layout.tsx  globals.css
   │  ├─ login/page.tsx
   │  ├─ (app)/layout.tsx            ERP shell
   │  ├─ (app)/page.tsx              dashboard
   │  ├─ (app)/inventory/page.tsx
   │  ├─ (app)/transactions/page.tsx
   │  └─ api/movements/{route.ts,reverse/route.ts}
   └─ components/
      ├─ shell/AppShell.tsx
      ├─ inventory/InventoryBrowser.tsx
      └─ transactions/TransactionsView.tsx
```

## Still to come (next build phase)

`/reports`, `/admin`, `/admin/activity` and `/m` are in the sidebar but not built yet — they
will 404 until the next phase, which covers the mobile PWA with quick outward and voice entry,
the reports module with PDF and Excel export, and the admin area with in-app Excel import,
user management, settings, backup and the activity trail.
