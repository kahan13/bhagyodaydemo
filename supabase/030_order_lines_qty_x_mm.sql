-- =====================================================================================
-- 030  Production order lines remember QTY x MM (for WhatsApp, print, PDF and reprints)
--
--   * production_order_items.pieces / length_mm  - what was typed as  QTY x MM.
--     quantity stays the total in mm, so nothing else in the system changes.
--     Old orders have NULL here and keep showing just the total.
--   * Inward lot trace now records the lot's real status (Full Sleeve or Cut Pcs).
--     Before, it always said FULL_SLEEVE, which was wrong for Cut Pcs inwards from 029.
-- Safe to re-run. Run after 029.
-- =====================================================================================

ALTER TABLE production_order_items
  ADD COLUMN IF NOT EXISTS pieces    int,
  ADD COLUMN IF NOT EXISTS length_mm numeric;

CREATE OR REPLACE FUNCTION trg_lot_created_trace()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.inward_movement_id IS NOT NULL THEN
    UPDATE inventory_movements
       SET lot_breakdown = COALESCE(lot_breakdown, '[]'::jsonb) ||
             jsonb_build_object('lot_no', NEW.lot_no, 'status', NEW.status, 'qty', NEW.inward_qty)
     WHERE id = NEW.inward_movement_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sku_lot_created_trace ON sku_lots;
CREATE TRIGGER sku_lot_created_trace AFTER INSERT ON sku_lots
  FOR EACH ROW EXECUTE FUNCTION trg_lot_created_trace();

SELECT 'ok' AS status;
