/**
 * Contracts shared by the web app and the mobile PWA.
 * These describe the shape of database rows - they never contain product data.
 */

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
  | 'products.view' | 'products.create' | 'products.edit' | 'products.disable'
  | 'users.view' | 'users.create' | 'users.edit' | 'users.disable'
  | 'settings.view' | 'settings.edit' | 'settings.import' | 'settings.backup'
  | 'audit.view';

export interface AppUser {
  id: string;
  auth_user_id: string | null;
  user_code: string | null;
  full_name: string;
  username: string;
  email: string | null;
  mobile: string | null;
  role_code: RoleCode;
  primary_device: 'WEB' | 'MOBILE_PWA';
  is_active: boolean;
}

export interface Session {
  user: AppUser;
  permissions: Permission[];
}

/** One row of v_sku_status - everything the browse tree and drawer need. */
export interface SkuStatus {
  id: string;
  sku_code: string;
  product_type: ProductType;
  display_name: string;
  exact_size: string;
  /** TIMING_BELT: family / exact size / brand.  V_BELT: brand / profile / exact size. */
  hier_l1: string;
  hier_l2: string;
  hier_l3: string;
  brand_code: string;
  brand_name: string;
  family_code: string;
  family_name: string;
  profile_group: string | null;
  size_designation: string | null;
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
  notes: string | null;
  channel: Channel;
  user_id: string | null;
  user_name: string;
  reversal_of: string | null;
  reversed_by: string | null;
  is_reversed: boolean;
  sku_code: string;
  display_name: string;
  product_type: ProductType;
  exact_size: string;
  brand_name: string;
  family_code: string;
  family_name: string;
  role_code: RoleCode | null;
}

export interface DashboardSummary {
  total_skus: number;
  timing_skus: number;
  vbelt_skus: number;
  low_stock: number;
  out_of_stock: number;
  today_inward: number;
  today_outward: number;
  today_adjustments: number;
  month_movements: number;
}

/** How each product type is browsed. Labels come from the data, not from code. */
export const HIERARCHY: Record<ProductType, { label: string; levels: [string, string, string] }> = {
  TIMING_BELT: { label: 'Timing Belts', levels: ['Family', 'Size', 'Brand'] },
  V_BELT: { label: 'V-Belts', levels: ['Brand', 'Profile', 'Size'] },
};
