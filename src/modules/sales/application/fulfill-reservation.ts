/**
 * 予約を引き渡す。**ここで初めて売上が立つ。**
 *
 * 単価は引き渡し時点 (= 販売時点) の catalog の価格を焼き付ける。予約受付時の価格では
 * ないのは、売上が立つのが引き渡しの瞬間だからで、`getDailySales` の日付とも揃う。
 *
 * ロットは引き渡しの瞬間に決まるので、明細は入力から受け取る。1 つの予約行が
 * 複数ロットに割れてもよいが、商品ごとの合計個数は予約と一致していなければならない。
 */
import { SalesError } from "../domain/errors.ts";
import { parseInstant } from "../domain/instant.ts";
import { assertMatchesReservation, assertPlaced } from "../domain/reservation.ts";
import { buildSale, toSaleCompletedPayload } from "../domain/sale.ts";
import type { FulfillReservationInput } from "./inputs.ts";
import type { SalesDeps } from "./ports.ts";
import { fetchUnitPrices, unitPriceOf } from "./pricing.ts";
import { toSoldLines } from "./record-sale.ts";

export async function fulfillReservation(
  deps: SalesDeps,
  input: FulfillReservationInput,
): Promise<string> {
  const fulfilledAt = parseInstant(input.fulfilledAt, "fulfilledAt");
  const lines = toSoldLines(input.lines);

  // 受け付けた予約は、その後に販売停止になっても引き渡す (客との約束が先)。
  // 販売停止で止めたいなら予約をキャンセルする、という運用にできるようにしてある。
  // そのため requireSellable は false。価格だけを引く。
  const prices = await fetchUnitPrices(
    deps.products,
    lines.map((line) => line.productId),
    { requireSellable: false },
  );

  return deps.uow.run(async (tx) => {
    // 行ロックを取る。同じ予約を 2 回引き渡して売上を二重計上しないため。
    const locked = await tx.lockReservation(input.reservationId);
    if (locked === null) {
      throw new SalesError("reservation_not_found", `予約 ${input.reservationId} は見つかりません`);
    }
    assertPlaced(locked.reservation, "引き渡し");
    assertMatchesReservation(locked.lines, lines);

    const sale = buildSale({
      saleId: deps.newId(),
      channel: "reservation",
      soldAt: fulfilledAt,
      reservationId: locked.reservation.reservationId,
      lines,
      unitPriceOf: unitPriceOf(prices),
    });

    await tx.insertSale(sale);
    await tx.markReservationFulfilled(locked.reservation.reservationId, sale.saleId, fulfilledAt);
    await tx.publishSaleCompleted(toSaleCompletedPayload(sale));
    return sale.saleId;
  });
}
