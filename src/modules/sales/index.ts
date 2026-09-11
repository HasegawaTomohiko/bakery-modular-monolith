/**
 * sales モジュールの公開 API (支援)。
 *
 * 責務: 店頭販売、予約注文、売上
 *
 * sales は在庫を持たない。どのロットを売ったかをイベントで伝え、
 * 出庫は inventory が行う (結果整合)。
 *
 * 公開シグネチャは Phase 4a で確定した契約。実装 (Phase 4b) で変えないこと。
 */
import { defineSubscription, type Subscription } from "../../shared/event-bus.ts";
import type { EventPayload, Quantity } from "../../shared/events.ts";
import { salesContext } from "./application/context.ts";
import { fulfillReservation as fulfillReservationUseCase } from "./application/fulfill-reservation.ts";
import { handleProductDelisted } from "./application/handle-product-delisted.ts";
import { placeReservation as placeReservationUseCase } from "./application/place-reservation.ts";
import {
  getDailySales as getDailySalesQuery,
  listReservations as listReservationsQuery,
} from "./application/queries.ts";
import { recordSale as recordSaleUseCase } from "./application/record-sale.ts";
import { productReferenceCopy } from "./infra/sales-repository.ts";

// ---------------------------------------------------------------------------
// 公開型
// ---------------------------------------------------------------------------

export type SaleId = string;
export type ReservationId = string;
/** catalog の商品識別子。商品情報そのものは catalog に同期で問い合わせる。 */
export type ProductId = string;
export type LotCode = string;

export type SaleChannel = EventPayload<"sales.SaleCompleted">["channel"];

export type SaleLineInput = {
  readonly productId: ProductId;
  readonly lotCode: LotCode;
  readonly quantity: Quantity;
};

export type RecordSaleInput = {
  readonly soldAt: string;
  readonly lines: readonly SaleLineInput[];
};

export type PlaceReservationInput = {
  readonly customerName: string;
  readonly pickupDate: string;
  readonly lines: readonly { readonly productId: ProductId; readonly quantity: Quantity }[];
};

export type FulfillReservationInput = {
  readonly reservationId: ReservationId;
  readonly fulfilledAt: string;
  readonly lines: readonly SaleLineInput[];
};

export type DailySalesView = {
  readonly businessDate: string;
  readonly totalJpy: number;
  readonly byProduct: readonly {
    readonly productId: ProductId;
    readonly soldQuantity: Quantity;
    readonly subtotalJpy: number;
  }[];
};

export type ReservationView = {
  readonly reservationId: ReservationId;
  readonly customerName: string;
  readonly pickupDate: string;
  readonly status: "placed" | "fulfilled" | "cancelled";
};

// ---------------------------------------------------------------------------
// 公開ユースケース
// ---------------------------------------------------------------------------

export const sales = {
  /** 店頭販売を記録する。`sales.SaleCompleted` を発行する。 */
  recordSale(input: RecordSaleInput): Promise<SaleId> {
    return recordSaleUseCase(salesContext(), input);
  },

  placeReservation(input: PlaceReservationInput): Promise<ReservationId> {
    return placeReservationUseCase(salesContext(), input);
  },

  /** 予約を引き渡す。ここで販売が確定するので `sales.SaleCompleted` を発行する。 */
  fulfillReservation(input: FulfillReservationInput): Promise<SaleId> {
    return fulfillReservationUseCase(salesContext(), input);
  },

  getDailySales(businessDate: string): Promise<DailySalesView> {
    return getDailySalesQuery(salesContext(), businessDate);
  },

  listReservations(pickupDate: string): Promise<readonly ReservationView[]> {
    return listReservationsQuery(salesContext(), pickupDate);
  },
} as const;

// ---------------------------------------------------------------------------
// 購読
// ---------------------------------------------------------------------------

export const salesSubscriptions: readonly Subscription[] = [
  defineSubscription({
    subscriber: "sales",
    handler: "stop-selling-delisted-product",
    eventName: "catalog.ProductDelisted",
    // 参照している商品情報 (売ってよいかどうか) を写し取り、売れないようにする。
    // tx は shared が inbox の記録と同じトランザクションで渡してくるので、
    // 「処理したが記録できていない」は起きない。
    handle: async (event, tx) => {
      await handleProductDelisted(productReferenceCopy(tx), event.payload);
    },
  }),
];
