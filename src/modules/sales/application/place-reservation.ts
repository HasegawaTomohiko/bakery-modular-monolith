/**
 * 予約を受け付ける。
 *
 * **受付は売上ではない。** 取りに来られない予約があるので、ここで売上に数えると
 * 売上が水増しされる。売上が立つのは引き渡し (fulfill-reservation.ts) だけ。
 * したがってここでは販売確定イベントも出さない。
 *
 * 価格も焼き付けない。焼き付けるのは販売が確定する引き渡し時点の価格なので、
 * catalog への同期の問い合わせもここでは不要。
 */

import { invalidInput } from "../domain/errors.ts";
import { parseIsoDate } from "../domain/instant.ts";
import { toPieces } from "../domain/quantity.ts";
import { normalizeCustomerName, type ReservedLine } from "../domain/reservation.ts";
import type { PlaceReservationInput } from "./inputs.ts";
import type { SalesDeps } from "./ports.ts";
import { assertSellable } from "./record-sale.ts";

export async function placeReservation(
  deps: SalesDeps,
  input: PlaceReservationInput,
): Promise<string> {
  const customerName = normalizeCustomerName(input.customerName);
  const pickupDate = parseIsoDate(input.pickupDate, "pickupDate");
  if (input.lines.length === 0) {
    throw invalidInput("lines: 予約明細が空です");
  }
  const lines: readonly ReservedLine[] = input.lines.map((line, index) => ({
    productId: line.productId,
    pieces: toPieces(line.quantity, `lines[${index}].quantity`),
  }));

  return deps.uow.run(async (tx) => {
    // 販売停止中の商品は新規に受け付けない。判定は sales が持つ参照コピーで行う
    // (価格が要らないので catalog に同期で問い合わせる必要がない)。
    await assertSellable(
      tx,
      lines.map((line) => line.productId),
    );

    const reservationId = deps.newId();
    await tx.insertReservation({
      reservationId,
      customerName,
      pickupDate,
      placedAt: deps.now(),
      lines,
    });
    return reservationId;
  });
}
