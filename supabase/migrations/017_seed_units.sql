-- =====================================================================================
-- 017 – Seed common units + unblock any SKU already stuck on a missing unit code
--
-- WHY
--   The import screen only ever created a 'PCS' row in `units`. Any sheet row
--   whose Unit column said something else (MM, MTR, ROLL, SET, KG…) got
--   silently downgraded to PCS by the importer's old hardcoded whitelist —
--   except the Edit Product dialog's Unit dropdown was ALSO hardcoded
--   (['PCS','MTR','MM','ROLL','SET']) and not read from the `units` table at
--   all. So it was possible to select "MM" there and save it onto a SKU row
--   even though no 'MM' row existed in `units` — the next save after that
--   hits `skus_unit_code_fkey` because the column's foreign key has nothing
--   to point to. This is exactly the roll-length save error you hit.
--
-- WHAT THIS DOES
--   Seeds every unit the app's dropdowns and your sheets commonly use, so
--   whichever unit code is already sitting on a SKU row has a home in
--   `units`. Safe to re-run — ignoreDuplicates-style upsert, touches nothing
--   that already exists.
-- =====================================================================================

INSERT INTO units (code, name, decimals) VALUES
  ('PCS',  'Pieces',     0),
  ('MTR',  'Meters',     2),
  ('MM',   'Millimeters',0),
  ('ROLL', 'Rolls',      0),
  ('SET',  'Sets',       0),
  ('KG',   'Kilograms',  2)
ON CONFLICT (code) DO NOTHING;

-- Verify — should show all 6 rows now present
SELECT code, name, decimals FROM units ORDER BY code;
