/**
 * SalesTx の drizzle 実装。
 *
 * 1 つのトランザクション (Executor) を包んで、ユースケースが必要とする操作だけを見せる。
 * 触れるのは sales スキーマのテーブルだけ。他モジュールのスキーマにはロールの権限が
 * 無いので、JOIN も外部キーもそもそも書けない (境界の強制 2/3)。
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { EventPayload } from "../../../shared/events.ts";
import { publishEvent } from "../../../shared/outbox.ts";
import type { Executor } from "../../../shared/tables.ts";
import type { ProductReferenceCopy } from "../application/handle-product-delisted.ts";
import type {
  DailySalesRow,
  LockedReservation,
  NewReservation,
  SalesTx,
} from "../application/ports.ts";
import type { ReservationStatus, ReservedLine } from "../domain/reservation.ts";
import type { Sale } from "../domain/sale.ts";
import {
  productSellability,
  reservationLines,
  reservations,
  saleLines,
  saleRecords,
} from "./db/schema.ts";

/** 参照コピーの更新。購読ハンドラが shared から受け取った tx をそのまま使う。 */
export function productReferenceCopy(tx: Executor): ProductReferenceCopy {
  return {
    async markDelisted(productId, delistedAt, reason) {
      await tx
        .insert(productSellability)
        .values({
          productId,
          sellable: false,
          delistedAt,
          delistReason: reason,
          updatedAt: new Date(),
        })
        // 同じ商品が再度停止されることもある。最後に届いた事実で上書きする。
        .onConflictDoUpdate({
          target: productSellability.productId,
          set: { sellable: false, delistedAt, delistReason: reason, updatedAt: new Date() },
        });
    },
  };
}

export function salesTx(tx: Executor): SalesTx {
  return {
    async insertSale(sale: Sale) {
      await tx.insert(saleRecords).values({
        id: sale.saleId,
        channel: sale.channel,
        soldAt: sale.soldAt,
        businessDate: sale.businessDate,
        totalJpy: sale.totalJpy,
        reservationId: sale.reservationId,
      });
      await tx.insert(saleLines).values(
        sale.lines.map((line) => ({
          saleId: sale.saleId,
          productId: line.productId,
          lotCode: line.lotCode,
          quantityPieces: line.pieces,
          unitPriceJpy: line.unitPriceJpy,
          subtotalJpy: line.subtotalJpy,
        })),
      );
    },

    async findUnsellableProducts(productIds) {
      if (productIds.length === 0) return [];
      const rows = await tx
        .select({ productId: productSellability.productId })
        .from(productSellability)
        .where(
          and(
            inArray(productSellability.productId, [...new Set(productIds)]),
            eq(productSellability.sellable, false),
          ),
        );
      return rows.map((row) => row.productId);
    },

    async insertReservation(reservation: NewReservation) {
      await tx.insert(reservations).values({
        id: reservation.reservationId,
        customerName: reservation.customerName,
        pickupDate: reservation.pickupDate,
        status: "placed",
        placedAt: reservation.placedAt,
      });
      await tx.insert(reservationLines).values(
        reservation.lines.map((line) => ({
          reservationId: reservation.reservationId,
          productId: line.productId,
          quantityPieces: line.pieces,
        })),
      );
    },

    async lockReservation(reservationId): Promise<LockedReservation | null> {
      // 予約行に FOR UPDATE を掛けてから明細を読む。引き渡しとキャンセルが
      // 同時に走っても、片方が待たされて状態を見直すことになる。
      const found = await tx
        .select({
          reservationId: reservations.id,
          customerName: reservations.customerName,
          pickupDate: reservations.pickupDate,
          status: reservations.status,
        })
        .from(reservations)
        .where(eq(reservations.id, reservationId))
        .for("update");

      const reservation = found[0];
      if (reservation === undefined) return null;

      const lines = await tx
        .select({
          productId: reservationLines.productId,
          pieces: reservationLines.quantityPieces,
        })
        .from(reservationLines)
        .where(eq(reservationLines.reservationId, reservationId));

      return {
        reservation: { ...reservation, status: reservation.status as ReservationStatus },
        lines: lines satisfies readonly ReservedLine[],
      };
    },

    async markReservationFulfilled(reservationId, saleId, fulfilledAt) {
      await tx
        .update(reservations)
        .set({ status: "fulfilled", fulfilledAt, saleId })
        .where(eq(reservations.id, reservationId));
    },

    async markReservationCancelled(reservationId, cancelledAt) {
      await tx
        .update(reservations)
        .set({ status: "cancelled", cancelledAt })
        .where(eq(reservations.id, reservationId));
    },

    async listReservations(pickupDate) {
      const rows = await tx
        .select({
          reservationId: reservations.id,
          customerName: reservations.customerName,
          pickupDate: reservations.pickupDate,
          status: reservations.status,
        })
        .from(reservations)
        .where(eq(reservations.pickupDate, pickupDate))
        .orderBy(asc(reservations.placedAt), asc(reservations.id));
      return rows.map((row) => ({ ...row, status: row.status as ReservationStatus }));
    },

    async aggregateDailySales(businessDate): Promise<readonly DailySalesRow[]> {
      // sum() は数値型でも文字列で返る (桁あふれしない型で受けるため) ので、
      // ここで number に直す。個数も金額も int の合計なので安全に収まる。
      const rows = await tx
        .select({
          productId: saleLines.productId,
          soldPieces: sql<string>`sum(${saleLines.quantityPieces})`,
          subtotalJpy: sql<string>`sum(${saleLines.subtotalJpy})`,
        })
        .from(saleLines)
        .innerJoin(saleRecords, eq(saleLines.saleId, saleRecords.id))
        .where(eq(saleRecords.businessDate, businessDate))
        .groupBy(saleLines.productId)
        .orderBy(asc(saleLines.productId));

      return rows.map((row) => ({
        productId: row.productId,
        soldPieces: Number(row.soldPieces),
        subtotalJpy: Number(row.subtotalJpy),
      }));
    },

    async publishSaleCompleted(payload: EventPayload<"sales.SaleCompleted">) {
      // 業務データの書き込みと同じ tx。outbox だけ、業務データだけ、が起きない。
      await publishEvent(tx, "sales", "sales.SaleCompleted", payload);
    },
  };
}
