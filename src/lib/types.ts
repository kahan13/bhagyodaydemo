export type ProductType = 'TIMING_BELT' | 'V_BELT' | 'CONVEYOR_BELT' | 'POLY_V_BELT' | 'OPEN_ROLL';
export type TxnType = 'INWARD' | 'OUTWARD' | 'ADJUSTMENT';
export type TxnMode = 'NORMAL' | 'REVERSAL';
export type Channel = 'WEB' | 'MOBILE_PWA' | 'MOBILE_VOICE' | 'IMPORT' | 'SYSTEM';
export type StockStatus = 'OK' | 'LOW_STOCK' | 'OUT_OF_STOCK';
/** Shown as Admin / Accounts / Workshop (see ROLE_LABEL). The codes are historical and never shown. */
export type RoleCode = 'SUPER_ADMIN' | 'MANAGER' | 'VIEWER';

/** The pages an Admin can switch on for a Workshop person. */
export type PageKey =
  | 'dashboard' | 'production_orders' | 'production_in_progress'
  | 'inventory' | 'purchase_orders' | 'transactions' | 'reports';

export interface PageAccess { page: PageKey; can_edit: boolean }

export type Permission =
  | 'inventory.view' | 'inventory.create' | 'inventory.edit' | 'inventory.adjust'
  | 'transactions.view' | 'transactions.create' | 'transactions.reverse'
  | 'reports.view' | 'reports.export'
  | 'products.view' | 'products.create' | 'products.edit'
  | 'users.view' | 'users.create' | 'users.edit' | 'users.disable'
  | 'settings.view' | 'settings.edit' | 'settings.import' | 'settings.backup'
  | 'audit.view'
  | 'production.view' | 'production.update';

export type PurchaseOrderStatus = 'PLACED' | 'PARTIAL' | 'FULFILLED';
export type PurchaseOrderItemStatus = 'PENDING' | 'PARTIAL' | 'FULFILLED';
export type ProductionOrderStatus = 'CREATED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export type TimeTag = '15-20 min' | '30-40 min' | '1 hour' | '2 hours';
export type DeliveryMode = 'Hand' | 'Porter' | 'Courier' | 'Transportation';

export interface AppUser {
  id: string;
  user_code: string | null;
  full_name: string;
  username: string;
  email: string | null;
  role_code: RoleCode;
  primary_device: 'WEB' | 'MOBILE_PWA';
  is_active: boolean;
}

export interface Session {
  user: AppUser;
  permissions: Permission[];
  /** Pages in the menu. Admin and Accounts: all of them, editable. Workshop: the ones switched on. */
  pages: PageAccess[];
}

/** One classification of a SKU's stock: e.g. 4 Full Sleeve pieces of 50 mm. */
export interface LotGroup {
  status: 'FULL_SLEEVE' | 'CUT_PCS';
  piece_qty: number;
  pieces: number;
  total_qty: number;
  /** Open Roll only: the width (mm) of these rolls */
  width_mm?: number | null;
}

export interface Sku {
  id: string;
  sku_code: string;
  product_type: ProductType;
  display_name: string;
  exact_size: string;
  hier_l1: string;
  hier_l2: string;
  hier_l3: string;
  search_text: string;
  section?: string | null;
  colour?: string | null;
  length_mm?: number | null;
  thickness_mm?: number | null;
  remarks?: string | null;
  /** Full Sleeve / Cut Pcs breakdown (timing belts); filled by the catalog. */
  lot_groups?: LotGroup[];
  brand_code: string;
  brand_name: string;
  family_code: string;
  family_name: string;
  profile_group: string | null;
  belt_form: string | null;
  construction: string | null;
  standard: string | null;
  pitch_mm: number | null;
  pitch_length_mm: number | null;
  width_mm: number | null;
  teeth: number | null;
  nominal_length: number | null;
  length_designation: string | null;
  rack_location: string | null;
  unit_code: string;
  opening_stock: number;
  current_stock: number;
  physical_prod_stock: number;
  min_stock_level: number;
  supplier_moq: number;
  reorder_quantity: number;
  supplier_name: string | null;
  is_active: boolean;
  stock_status: StockStatus;
  shortfall: number;
  suggested_purchase_qty: number;
  /** Timing belts: pieces in stock (what MSL is compared with). Others: same as stock. */
  stock_pieces?: number;
  /** Identity parts an import could not fill (saved as UNSPECIFIED). Empty = complete. */
  missing_fields?: string[];
}

export interface Movement {
  id: string;
  txn_no: string;
  occurred_at: string;
  txn_type: TxnType;
  txn_mode: TxnMode;
  quantity: number;
  unit_code: string;
  previous_stock: number;
  new_stock: number;
  reference: string | null;
  invoice_no: string | null;
  notes: string | null;
  channel: Channel;
  user_id: string | null;
  user_name: string;
  reversal_of: string | null;
  reversed_by: string | null;
  is_reversed: boolean;
  operated_by_user_id: string | null;
  operated_by_name: string | null;
  sku_code: string;
  display_name: string;
  product_type: ProductType;
  exact_size: string;
  brand_name: string;
  family_code: string;
  /** Lots this movement created / used / put back: [{lot_no,status,qty,new_lot?}] */
  lot_breakdown?: import('./lotView').LotEntry[] | null;
  lot_tracked?: boolean;
  /** Lot groups before / after this movement: [{status,each,count}] */
  lot_state?: { before: { status: 'CUT_PCS' | 'FULL_SLEEVE'; each: number; count: number; width_mm?: number }[]; after: { status: 'CUT_PCS' | 'FULL_SLEEVE'; each: number; count: number; width_mm?: number }[] } | null;
}

export interface DashboardSummary {
  total_skus: number;
  timing_skus: number;
  vbelt_skus: number;
  low_stock: number;
  out_of_stock: number;
  today_inward: number;
  today_outward: number;
  today_adjust: number;
  month_moves: number;
  total_moves: number;
}

export interface PurchaseOrder {
  id: string;
  order_no: string;
  supplier_name: string | null;
  notes: string | null;
  status: PurchaseOrderStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrderItem {
  id: string;
  order_id: string;
  sku_id: string;
  ordered_qty: number;
  received_qty: number;
  status: PurchaseOrderItemStatus;
  notes: string | null;
  created_at: string;
  // joined fields
  sku_code?: string;
  exact_size?: string;
  brand_name?: string;
  unit_code?: string;
  current_stock?: number;
}

export interface PurchaseOrderReceipt {
  id: string;
  order_item_id: string;
  qty_received: number;
  movement_id: string | null;
  received_at: string;
  received_by: string | null;
  notes: string | null;
}

export interface ProductionOrderItem {
  id: string;
  order_id: string;
  sku_id: string | null;
  sku_code: string;
  display_name: string;
  unit_code: string;
  quantity: number;
  /** QTY × MM as typed (quantity = pieces × length_mm). NULL on older orders. */
  pieces?: number | null;
  length_mm?: number | null;
  /** Open Roll lines only: the width of each piece (mm) */
  width_mm?: number | null;
  reserved_qty: number;
  is_fulfilled: boolean;
  notes: string | null;
  created_at: string;
}

/** One open production order item contributing to a SKU mismatch */
export interface MismatchOrderItem {
  poi_id: string;
  order_id: string;
  order_no: string;
  customer_name: string | null;
  order_status: ProductionOrderStatus;
  quantity: number;
  unit_code: string;
  /** MM × PCS as entered (timing belts); null on older orders */
  pieces?: number | null;
  length_mm?: number | null;
  /** Open Roll / Rubber: width of each piece (mm) */
  width_mm?: number | null;
  created_at: string;
}

/** Row from v_production_stock_status — only mismatched SKUs shown in UI */
export interface SkuMismatch {
  sku_id: string;
  sku_code: string;
  display_name: string;
  unit_code: string;
  current_stock: number;
  physical_prod_stock: number;
  stock_gap: number;          // current_stock - physical_prod_stock (always > 0 for mismatch)
  is_mismatched: boolean;
  open_order_items: MismatchOrderItem[];
  pending_net?: number;
  /** Items whose outward is not recorded yet (completed orders included) */
  open_item_count?: number;
}

/** Book-only movement (waste / adjustment) awaiting reconciliation with physical stock */
export interface PendingAdjustment {
  id: string;
  movement_id: string;
  sku_id: string;
  delta: number;
  source: 'WASTE' | 'ADJUSTMENT';
  lot_no: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
  skus?: { sku_code: string; display_name: string; unit_code: string } | null;
}

export interface ProductionOrder {
  id: string;
  order_no: string;
  customer_name: string | null;
  // Legacy single-SKU fields (kept for old rows)
  sku_id: string | null;
  product_description: string;
  quantity: number | null;
  unit_code: string | null;
  // Replaced due_date with time_tag
  time_tag: TimeTag | null;
  // Delivery fields
  delivery_mode: DeliveryMode | null;
  delivery_note: string | null;
  // Fulfillment
  assigned_to: string | null;
  notes: string | null;
  whatsapp_number: string | null;
  whatsapp_message: string | null;
  status: ProductionOrderStatus;
  /** Direct (drop-ship) order: no SKU, no stock effect; staff are reminded to post inward/outward */
  is_direct?: boolean;
  direct_inward_at?: string | null;
  direct_inward_by?: string | null;
  direct_outward_at?: string | null;
  direct_outward_by?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined from v_production_orders (may be undefined if loaded from base table)
  items?: ProductionOrderItem[];
}

/**
 * Inventory drill-down — three panes, matching the real sheets:
 *   Product Family  →  Section (Colour for conveyor)  →  Size · Brand
 * hier_l1/l2/l3 are filled at import time from the sheet (see sheet-config.ts).
 */
export const HIERARCHY: Record<ProductType, { label: string; short: string; levels: [string, string, string] }> = {
  TIMING_BELT:   { label: 'Timing Belts',   short: 'Timing',   levels: ['Product Family', 'Section', 'Size · Make'] },
  V_BELT:        { label: 'V-Belts',        short: 'V-Belt',   levels: ['Product Family', 'Make',    'Section · Size'] },
  CONVEYOR_BELT: { label: 'Conveyor Belts', short: 'Conveyor', levels: ['Product Family', 'Colour',  'Size · Make'] },
  POLY_V_BELT:   { label: 'Poly V Belts',   short: 'Poly V',   levels: ['Product Family', 'Section', 'Size · Make'] },
  OPEN_ROLL:     { label: 'Open Roll / Rubber', short: 'Open Roll', levels: ['Product Family', 'Section', 'Make'] },
};

/** Display names for a product type, used by filters, badges and reports. */
export const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
  TIMING_BELT: 'Timing Belt',
  V_BELT: 'V-Belt',
  CONVEYOR_BELT: 'Conveyor Belt',
  POLY_V_BELT: 'Poly V Belt',
  OPEN_ROLL: 'Open Roll / Rubber',
};
