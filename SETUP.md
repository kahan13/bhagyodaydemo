# Bhagyoday Belts — Inventory Management System

Next.js 15 · React 19 · Tailwind 4 · Supabase Postgres · deploys to Vercel. No Docker.

---

## The rule this build is designed around

**No product data lives in the application code.** Brands, families, sizes, units, opening stock
and history all arrive through `scripts/import-master-excel.mjs`. Each SKU carries `hier_l1 /
hier_l2 / hier_l3`, and React renders whatever tree those columns describe:

| Product type | Level 1 | Level 2 | Level 3 |
|---|---|---|---|
| Timing belts | Family (HTD8M, AT10, L…) | Exact size (1200-8M-30) | Brand |
| V-belts | Brand | Profile (A, SPB, XPZ…) | Exact size (B-42) |

Swapping in the real workbook is one command. Nothing in `src/` changes.

---

## Setup

**1. Supabase.** New project → region **Mumbai (ap-south-1)**. SQL Editor → paste
`supabase/migrations/001_init.sql` → Run, then `002_auth_provisioning.sql` → Run. The first
drops any v1 objects and rebuilds everything; the second adds account provisioning. Both are
safe to re-run, though 001 clears data, so run it only when you intend to start over.

**2. Keys.** Project Settings → API. Copy the URL, the `anon` key and the `service_role` key.

**3. Groq (optional but recommended).** Free key from <https://console.groq.com/keys>. Without it
voice entry silently falls back to the browser's own speech engine.

```powershell
copy env.example .env.local      # fill in the four values
npm install
```

**4. Load the data.**

```powershell
npm run import:validate    # writes nothing, prints a full preview
npm run import:demo        # commits masters, SKUs and history
```

Watch for `reconciliation: stock matches the ledger exactly` — that is the database recomputing
every stock figure from the movement history and agreeing with the script's independent replay.

The import loads product data and the *names* attached to demo history. It does not create
sign-in accounts.

**5. Create your login.** Supabase → Authentication → Users → **Add user**, with
"Auto Confirm User" ticked. That is the only place accounts are managed.

**6. Run.**

```powershell
npm run dev
```

Sign in at <http://localhost:3000>.

---

## How accounts work

Supabase Auth owns identity and passwords. The app additionally needs a **role** and a name to
stamp on every movement, which Auth has no concept of — so it keeps a matching `app_users` row.

You never create that row by hand. On first sign-in the app resolves it:

1. Already linked → used as-is.
2. An unlinked profile with the same email → adopted, keeping its role and history. This is how
   an account created in Supabase picks up a role that arrived through the master workbook.
3. Nothing found → a profile is created.

**The first account to sign in becomes Super Admin**, so a fresh project cannot lock you out.
Every account after that gets `VIEWER`, unless the Auth user carries a role in its metadata:

```json
{ "full_name": "Rahul Shah", "role": "MANAGER" }
```

Valid roles: `SUPER_ADMIN`, `MANAGER`, `INVENTORY_OPERATOR`, `VIEWER`.

To change someone's role later, edit `role_code` on their `app_users` row in Supabase. To revoke
access, set `is_active` to false — deleting the row would orphan the movements they recorded.

Since the first sign-in is privileged, turn off public signups under Supabase → Authentication →
Providers → Email before this is reachable from the internet. To disable provisioning entirely
once your accounts exist:

```sql
update app_settings
   set value = jsonb_build_object('enabled', false, 'default_role', 'VIEWER')
 where key = 'auto_provision';
```

---

## Deploy to Vercel

Push to GitHub → import the repo → add the same four environment variables under
**Settings → Environment Variables** (tick Production) → deploy.

If you add variables after the first build, redeploy — Vercel does not apply them retroactively.

---

## Voice entry

Hold the button, speak, release:

> "1200-8M-30 Optibelt 40 meter outward"

Audio goes to Groq's `whisper-large-v3-turbo`, which returns a transcript and nothing else — the
recording is never written to disk, a database or a log. A deterministic parser in
`src/lib/voice.ts` turns the transcript into a product, a quantity and a direction. No model
decides anything: it either matches a real SKU and a real number, or the worker is asked to pick.

The parser knows the difference between a size and a quantity — in "twenty pieces A-38 Fenner
inward" the quantity is twenty, not 38 — and understands spoken numbers in English and Hinglish
("das", "bees", "panch").

Nothing commits until Confirm is tapped. If Groq is missing, rate limited or unreachable, the app
falls back to the phone's own recogniser automatically, so a demo never dies mid-pitch.

---

## Adding to a phone's home screen

Open the deployed URL in Chrome on Android → menu → **Add to Home screen**. It opens at `/m`,
full screen, no browser chrome. The app shell is cached for instant startup, but stock figures are
always fetched live — serving a stale number to someone cutting belts would be worse than waiting.

---

## How stock works

Stock is never typed in. It is the result of movements:

```
opening stock + inward − outward ± adjustment = current stock
```

* `record_movement()` locks the SKU row, re-checks the caller's permission, enforces the SKU's
  unit, refuses to go below zero unless an admin allows it, writes previous/new stock with the
  timestamp, user and device, and logs the audit entry — one transaction.
* `reverse_movement()` is the only correction path. The original is untouched; a linked opposite
  entry is created. There is no delete endpoint, and a database trigger refuses deletes outright.
* `reconcile_stock()` recomputes everything from the ledger and returns any disagreement. It
  should always return zero rows.

Permissions are enforced in the database and by row level security. An operator who calls the API
directly is still refused — hiding a button is never the security boundary.

---

## Replacing the demo data

```powershell
node scripts/import-master-excel.mjs --file ./data/Real.xlsx
node scripts/import-master-excel.mjs --file ./data/Real.xlsx --commit --with-history --replace
```

`--replace` purges movement history through the controlled routine and deactivates SKUs absent
from the new file — it never deletes a SKU, so old transactions keep pointing at something real.

Then flip the banner:

```sql
update app_settings
   set value = jsonb_build_object('status','LIVE','note','Bhagyoday Belts master data')
 where key = 'data_source';
```

---

## What changed from v1, and why it is faster

| Before | Now |
|---|---|
| Webpack dev server | Turbopack — far quicker cold compiles |
| Auth check on every asset request | Middleware matcher skips static files entirely |
| Whole catalogue refetched per tab switch and keystroke | Fetched once, cached in memory, filtered locally |
| `select('*')` on every query | Explicit column lists |
| `window.location.reload()` after each transaction | Local state update, no reload |
| Every block waited for the slowest query | Dashboard sections stream independently |

---

## File map

```
bhagyoday-belts-ims/
├─ data/Bhagyoday_Belts_Demo_Master_Data.xlsx
├─ supabase/migrations/{001_init,002_auth_provisioning}.sql
├─ scripts/import-master-excel.mjs
├─ public/{manifest.webmanifest, sw.js, icons/}
└─ src/
   ├─ middleware.ts
   ├─ lib/{types,format,auth,voice,supabase-browser,supabase-server}.ts
   ├─ app/
   │  ├─ layout.tsx  globals.css
   │  ├─ login/page.tsx   no-access/page.tsx
   │  ├─ (app)/{layout,page}.tsx          shell + dashboard
   │  ├─ (app)/{inventory,transactions,reports}/page.tsx
   │  ├─ (app)/admin/{page,activity/page}.tsx
   │  ├─ m/{layout,page}.tsx              phone app
   │  └─ api/{movements,movements/reverse,voice/transcribe,export}/route.ts
   └─ components/
      ├─ shell/{AppShell,CommandPalette,SignOutButton}.tsx
      ├─ catalog/CatalogProvider.tsx
      ├─ inventory/{InventoryBrowser,MovementDialog}.tsx
      ├─ transactions/TransactionsView.tsx
      ├─ reports/ReportsView.tsx
      ├─ admin/AdminView.tsx
      ├─ mobile/{MobileApp,VoiceEntry}.tsx
      └─ pwa/RegisterSW.tsx
```

---

## Known gaps

Editing brands and users happens in Supabase, not in the app — Admin is read-only for those.
In-app Excel upload is not built; import runs from the command line. Both are deliberate for a
prototype, and neither blocks replacing the demo data.
