/**
 * 参照系のユースケース。
 *
 * 他コンテキストの情報 (商品名など) は混ぜない。識別子だけを返し、
 * 表示に必要な名前は呼び出し側が catalog に問い合わせる。JOIN で作れないのではなく、
 * 作ってはいけない (境界の強制 2/3)。
 */
import { parseIsoDate } from "../domain/instant.ts";
import { pieces } from "../domain/quantity.ts";
import type { DailySalesView, ReservationView } from "./inputs.ts";
import type { SalesDeps } from "./ports.ts";

/**
 * 1 日分の売上。「1 日」の定義は domain/business-date.ts を参照 (JST の暦日)。
 * 集計対象は販売レコードなので、受付だけで引き渡されていない予約は入らない。
 */
export async function getDailySales(
  deps: SalesDeps,
  businessDate: string,
): Promise<DailySalesView> {
  const date = parseIsoDate(businessDate, "businessDate");
  const rows = await deps.uow.run((tx) => tx.aggregateDailySales(date));

  return {
    businessDate: date,
    // 合計は明細の積み上げから出す。行の合計と総合計が食い違わないようにするため。
    totalJpy: rows.reduce((total, row) => total + row.subtotalJpy, 0),
    byProduct: rows.map((row) => ({
      productId: row.productId,
      soldQuantity: pieces(row.soldPieces),
      subtotalJpy: row.subtotalJpy,
    })),
  };
}

/** 受渡日で予約を引く。キャンセル済みも含めて返す (当日何が起きたかが分かるように)。 */
export async function listReservations(
  deps: SalesDeps,
  pickupDate: string,
): Promise<readonly ReservationView[]> {
  const date = parseIsoDate(pickupDate, "pickupDate");
  return deps.uow.run((tx) => tx.listReservations(date));
}
