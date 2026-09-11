/**
 * ユースケースが外側に求めるもの (ポート)。
 *
 * ここを型で切っておくことで、ユースケースは drizzle も catalog の実物も知らずに済み、
 * 単体テスト (DB 不要) では素朴なインメモリ実装を差し込める。
 * 実体は infra/ にある。
 */
import type { EventPayload } from "../../../shared/events.ts";
import type { Reservation, ReservedLine } from "../domain/reservation.ts";
import type { Sale } from "../domain/sale.ts";

/** catalog に同期で問い合わせて得られるもののうち、sales が使う分だけ。 */
export type ProductPrice = {
  readonly priceJpy: number;
  readonly sellable: boolean;
};

/**
 * catalog への同期の問い合わせ口。
 * 状態を変えないので同期で引いてよい (状態変化の通知だけが outbox 経由)。
 */
export type ProductPort = {
  getProduct(productId: string): Promise<ProductPrice | null>;
};

export type NewReservation = {
  readonly reservationId: string;
  readonly customerName: string;
  readonly pickupDate: string;
  readonly placedAt: Date;
  readonly lines: readonly ReservedLine[];
};

export type LockedReservation = {
  readonly reservation: Reservation;
  readonly lines: readonly ReservedLine[];
};

/** 日次売上の商品別の 1 行。 */
export type DailySalesRow = {
  readonly productId: string;
  readonly soldPieces: number;
  readonly subtotalJpy: number;
};

/**
 * 1 トランザクションの中でできること。
 *
 * `publishSaleCompleted` が同じ面に居るのが重要で、業務データの書き込みと
 * outbox への書き込みが同一トランザクションになることを型で示している
 * (境界の強制 3/3)。
 */
export type SalesTx = {
  insertSale(sale: Sale): Promise<void>;
  /** 参照コピーを見て、販売停止中の商品 ID だけを返す。 */
  findUnsellableProducts(productIds: readonly string[]): Promise<readonly string[]>;
  insertReservation(reservation: NewReservation): Promise<void>;
  /** 行ロックを取って予約を読む。二重引き渡し (= 売上の二重計上) を防ぐため。 */
  lockReservation(reservationId: string): Promise<LockedReservation | null>;
  markReservationFulfilled(reservationId: string, saleId: string, fulfilledAt: Date): Promise<void>;
  markReservationCancelled(reservationId: string, cancelledAt: Date): Promise<void>;
  listReservations(pickupDate: string): Promise<readonly Reservation[]>;
  aggregateDailySales(businessDate: string): Promise<readonly DailySalesRow[]>;
  publishSaleCompleted(payload: EventPayload<"sales.SaleCompleted">): Promise<void>;
};

export type UnitOfWork = {
  run<T>(work: (tx: SalesTx) => Promise<T>): Promise<T>;
};

export type SalesDeps = {
  readonly uow: UnitOfWork;
  readonly products: ProductPort;
  /** 識別子の採番。テストで固定するために外から渡す。 */
  readonly newId: () => string;
  readonly now: () => Date;
};
