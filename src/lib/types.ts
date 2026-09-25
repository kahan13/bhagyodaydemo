export type ProductType = 'TIMING_BELT' | 'V_BELT';
export type TxnType = 'INWARD' | 'OUTWARD' | 'ADJUSTMENT';
export type TxnMode = 'NORMAL' | 'REVERSAL';
export type Channel = 'WEB' | 'MOBILE_PWA' | 'MOBILE_VOICE' | 'IMPORT' | 'SYSTEM';
export type StockStatus = 'OK' | 'LOW_STOCK' | 'OUT_OF_STOCK';
export type RoleCode = 'SUPER_ADMIN' | 'MANAGER' | 'INVENTORY_OPERATOR' | 'VIEWER';

export type Permission =
  | 'inventory.view' | 'inventory.create' | 'inventory.edit' | 'inventory.adjust'
  | 'transactions.view' | 'transactions.create' | 'transactions.reverse'
  | 'reports.view' | 'reports.export'
  | 'products.view' | 'products.create' | 'products.edit'
  | 'users.view' | 'users.create' | 'users.edit' | 'users.disable'
  | 'settings.view' | 'settings.edit' | 'settings.import' | 'settings.backup'
  | 'audit.view';

export type PurchaseOrderStatus = 'PLACED' | 'PARTIAL' | 'FULFILLED';
export type PurchaseOrderItemStatus = 'PENDING' | 'PARTIAL' | 'FULFILLED';
export type ProductionOrderStatus = 'CREATED' | 'SENT' | 'IN_PROGRESS' | 'COMPLETED';

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
  min_stock_level: number;
  supplier_moq: number;
  reorder_quantity: number;
  supplier_name: string | null;
  is_active: boolean;
  stock_status: StockStatus;
  shortfall: number;
  suggested_purchase_qty: number;
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

export interface ProductionOrder {
  id: string;
  order_no: string;
  customer_name: string | null;
  // SKU link (new)
  sku_id: string | null;
  product_description: string;       // kept for display; populated from sku.display_name on create
  quantity: number | null;
  unit_code: string | null;
  // Replaced due_date with time_tag
  time_tag: TimeTag | null;
  // Delivery fields (new)
  delivery_mode: DeliveryMode | null;
  delivery_note: string | null;      // carrier / transport company name
  // Fulfillment (new)
  assigned_to: string | null;
  notes: string | null;
  whatsapp_number: string | null;
  whatsapp_message: string | null;
  status: ProductionOrderStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Both product types now follow the same three-level drill pattern:
 *   Category/Profile  →  Size  →  Brand
 * hier_l1/l2/l3 are resolved at import time per this mapping.
 */
export const HIERARCHY: Record<ProductType, { label: string; short: string; levels: [string, string, string] }> = {
  TIMING_BELT: { label: 'Timing Belts', short: 'Timing', levels: ['Family',  'Size', 'Brand'] },
  V_BELT:      { label: 'V-Belts',      short: 'V-Belt', levels: ['Profile', 'Size', 'Brand'] },
};
