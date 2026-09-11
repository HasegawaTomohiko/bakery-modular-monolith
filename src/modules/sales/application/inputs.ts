/**
 * ユースケースの入出力の形。
 *
 * index.ts の公開型と構造が同じものをここにも置いている。index.ts を application から
 * import すると index.ts → application → index.ts の循環になり、境界チェック
 * (`no-circular`) で落ちるため。構造が同じなので index.ts の型はそのまま渡せる。
 */
import type { Quantity } from "../../../shared/events.ts";

export type SaleLineInput = {
  readonly productId: string;
  readonly lotCode: string;
  readonly quantity: Quantity;
};

export type RecordSaleInput = {
  readonly soldAt: string;
  readonly lines: readonly SaleLineInput[];
};

export type PlaceReservationInput = {
  readonly customerName: string;
  readonly pickupDate: string;
  readonly lines: readonly { readonly productId: string; readonly quantity: Quantity }[];
};

export type FulfillReservationInput = {
  readonly reservationId: string;
  readonly fulfilledAt: string;
  readonly lines: readonly SaleLineInput[];
};

export type DailySalesView = {
  readonly businessDate: string;
  readonly totalJpy: number;
  readonly byProduct: readonly {
    readonly productId: string;
    readonly soldQuantity: Quantity;
    readonly subtotalJpy: number;
  }[];
};

export type ReservationView = {
  readonly reservationId: string;
  readonly customerName: string;
  readonly pickupDate: string;
  readonly status: "placed" | "fulfilled" | "cancelled";
};
