/**
 * Lot-tracked product types.
 *
 * Timing belts and poly V belts are both stocked as Full Sleeve / Cut Pcs lots and entered as
 * "length × PCS". The only difference is what a piece is measured in:
 *   timing belt  →  millimetres  (MM × PCS)
 *   poly V belt  →  ribs         (RIBS × PCS)
 *
 * Free of server imports so client components can use it.
 */

export const LOT_TYPES = ['TIMING_BELT', 'POLY_V_BELT'] as const;

/** Is this product type kept as Full Sleeve / Cut Pcs lots? */
export const isLotType = (productType?: string | null): boolean =>
  productType === 'TIMING_BELT' || productType === 'POLY_V_BELT';

/** "mm" for timing belts, "ribs" for poly V belts (lower case, for running text). */
export const lotUnitWord = (productType?: string | null): string =>
  productType === 'POLY_V_BELT' ? 'ribs' : 'mm';

/** "MM" / "RIBS" (upper case, for column headings and labels). */
export const lotUnitHead = (productType?: string | null): string =>
  productType === 'POLY_V_BELT' ? 'RIBS' : 'MM';

/** The unit code stocked in the database. */
export const lotUnitCode = (productType?: string | null): 'MM' | 'RIB' =>
  productType === 'POLY_V_BELT' ? 'RIB' : 'MM';

/** Same word, but decided from a unit code ("RIB" → "ribs", anything else → "mm"). */
export const lotUnitWordOfUnit = (unitCode?: string | null): string =>
  (unitCode ?? '').toUpperCase() === 'RIB' ? 'ribs' : 'mm';
