-- =====================================================================================
-- 014 – Restore Lots When an OUTWARD Is Reversed
--
-- WHAT THIS CLOSES
--   012 already handles reversing an INWARD: it closes that inward's lots and
--   blocks the reversal if any of them were already touched (cut or wasted).
--   OUTWARD had no equivalent — reversing an outward correctly restored the
--   book ledger (skus.current_stock) via the existing reverse_movement (001),
--   but the specific lots that were drained for that item stayed drained.
--   That let current_stock and the sum of sku_lots.current_qty quietly drift
--   apart, which is exactly the invariant everything else in this feature
--   depends on.
--
-- HOW reverse_movement WORKS (001, untouched)
--   Reversing an OUTWARD inserts a NEW movement row with
--     txn_type = 'INWARD', txn_mode = 'REVERSAL', reversal_of = <original id>
--   It does not carry source_poi_id itself — that lives on the ORIGINAL
--   movement (set by record_production_outward in 010), so this trigger reads
--   it from NEW.reversal_of.
--
-- WHAT THIS TRIGGER DOES
--   On insert of such a reversal row, look up the original outward's
--   source_poi_id, find every lot_allocations row for that production order
--   item, and restore_lot() each one by its allocated qty.
--
--   If a lot was WASTED in the meantime, restore_lot() raises (by design,
--   from 011 — a wasted lot is permanently closed) and the WHOLE reversal
--   rolls back, including the ledger entry reverse_movement just posted —
--   Postgres aborts the full transaction on an uncaught exception. The admin
--   will need to resolve that lot manually before this outward can be
--   reversed; this is a deliberate hard stop, not a bug, because silently
--   skipping it would reopen the invariant gap this migration exists to close.
--
--   Items with no source_poi_id (a manual, non-production OUTWARD) or no
--   lot_allocations (non-lot-tracked SKUs, or items that were never fully
--   allocated) are a no-op — this only ever restores lots that were actually
--   drained through record_production_outward_with_lots (013).
--
-- Nothing in 001–013 is modified. Safe to re-run.
-- =====================================================================================

CREATE OR REPLACE FUNCTION trg_reverse_outward_lots()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_source_poi_id uuid;
  v_row           record;
BEGIN
  IF NEW.txn_mode <> 'REVERSAL' OR NEW.txn_type <> 'INWARD' OR NEW.reversal_of IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT source_poi_id INTO v_source_poi_id
    FROM inventory_movements
   WHERE id = NEW.reversal_of;

  IF v_source_poi_id IS NULL THEN
    RETURN NEW; -- not a production-order outward, nothing to restore
  END IF;

  FOR v_row IN
    SELECT lot_id, allocated_qty
      FROM lot_allocations
     WHERE item_id = v_source_poi_id
  LOOP
    PERFORM restore_lot(v_row.lot_id, v_row.allocated_qty);
  END LOOP;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS movement_reverse_outward_lots ON inventory_movements;
CREATE TRIGGER movement_reverse_outward_lots
  AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION trg_reverse_outward_lots();
