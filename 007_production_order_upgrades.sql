-- =====================================================================================
-- 007 – Production Order Upgrades
-- Changes:
--   1. Daily-reset serial order number (PRO-1, PRO-2, … resets each day)
--   2. sku_id foreign key (links to actual SKU instead of free-text description)
--   3. time_tag instead of due_date  (e.g. '15-20 min', '30-40 min', '1 hour', '2 hours')
--   4. delivery_mode  (Hand | Porter | Courier | Transportation)
--   5. delivery_note  (carrier/transport name, used with Courier & Transportation)
--   6. assigned_to    (free-text name of who fulfils the order)
-- =====================================================================================

-- -----------------------------------------------------------------------
-- 1. Add new columns to production_orders
-- -----------------------------------------------------------------------
ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS sku_id        uuid        REFERENCES skus(id),
  ADD COLUMN IF NOT EXISTS time_tag      text        CHECK (time_tag IN ('15-20 min','30-40 min','1 hour','2 hours')),
  ADD COLUMN IF NOT EXISTS delivery_mode text        CHECK (delivery_mode IN ('Hand','Porter','Courier','Transportation')),
  ADD COLUMN IF NOT EXISTS delivery_note text,
  ADD COLUMN IF NOT EXISTS assigned_to   text;

-- -----------------------------------------------------------------------
-- 2. Daily-reset order number helper
--    Returns the next PRO-N for today.
--    Uses a simple count of today's rows + 1 (no separate sequence needed).
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION next_production_order_no()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_today      date    := current_date;
  v_count      integer;
  v_order_no   text;
  v_attempts   integer := 0;
BEGIN
  LOOP
    -- Count orders already created today
    SELECT COUNT(*) INTO v_count
    FROM production_orders
    WHERE created_at::date = v_today;

    v_order_no := 'PRO-' || (v_count + 1 + v_attempts);

    -- Ensure uniqueness (edge case: concurrent inserts)
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM production_orders WHERE order_no = v_order_no
    );

    v_attempts := v_attempts + 1;

    -- Safety guard
    IF v_attempts > 500 THEN
      RAISE EXCEPTION 'Could not generate unique order_no after 500 attempts';
    END IF;
  END LOOP;

  RETURN v_order_no;
END $$;

GRANT EXECUTE ON FUNCTION next_production_order_no() TO authenticated;

-- -----------------------------------------------------------------------
-- 3. Drop & recreate create_production_order with new signature
--    Old signature:  (text, text, numeric, text, date, text, text, text)
--    New signature:  (p_customer_name, p_sku_id, p_quantity, p_unit_code,
--                     p_time_tag, p_delivery_mode, p_delivery_note,
--                     p_assigned_to, p_notes, p_whatsapp_number, p_whatsapp_message)
-- -----------------------------------------------------------------------
DROP FUNCTION IF EXISTS create_production_order(text,text,numeric,text,date,text,text,text);

CREATE OR REPLACE FUNCTION create_production_order(
  p_customer_name      text    DEFAULT NULL,
  p_sku_id             uuid    DEFAULT NULL,
  p_product_description text   DEFAULT NULL,   -- kept for fallback display_name if needed
  p_quantity           numeric DEFAULT NULL,
  p_unit_code          text    DEFAULT NULL,
  p_time_tag           text    DEFAULT NULL,
  p_delivery_mode      text    DEFAULT NULL,
  p_delivery_note      text    DEFAULT NULL,
  p_assigned_to        text    DEFAULT NULL,
  p_notes              text    DEFAULT NULL,
  p_whatsapp_number    text    DEFAULT NULL,
  p_whatsapp_message   text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user      record;
  v_order_no  text;
  v_order_id  uuid;
BEGIN
  -- Identify calling user
  SELECT id INTO v_user FROM app_users WHERE id = auth.uid() LIMIT 1;

  -- Generate daily-reset order number
  v_order_no := next_production_order_no();

  INSERT INTO production_orders(
    order_no, customer_name, sku_id, product_description,
    quantity, unit_code,
    time_tag, delivery_mode, delivery_note, assigned_to,
    notes, whatsapp_number, whatsapp_message, created_by
  ) VALUES (
    v_order_no,
    p_customer_name,
    p_sku_id,
    p_product_description,
    p_quantity,
    p_unit_code,
    p_time_tag,
    p_delivery_mode,
    p_delivery_note,
    p_assigned_to,
    p_notes,
    p_whatsapp_number,
    p_whatsapp_message,
    v_user.id
  ) RETURNING id INTO v_order_id;

  RETURN jsonb_build_object('order_id', v_order_id, 'order_no', v_order_no);
END $$;

GRANT EXECUTE ON FUNCTION create_production_order(text,uuid,text,numeric,text,text,text,text,text,text,text,text) TO authenticated;
