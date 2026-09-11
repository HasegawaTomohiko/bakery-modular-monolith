/**
 * 予約をキャンセルする。
 *
 * 受付済みの予約だけがキャンセルできる。引き渡し済みの予約をキャンセルすると
 * 売上とイベント (既に inventory へ出庫指示が飛んでいる) と食い違うため。
 *
 * キャンセルは売上に一切影響しない (受付時点で売上にしていないので、取り消すものがない)。
 * したがってイベントも出さない。
 *
 * index.ts の公開ユースケースには含まれない (Phase 4a で確定した公開シグネチャを
 * 変更できないため)。HTTP からのみ呼べる。
 */
import { SalesError } from "../domain/errors.ts";
import { assertPlaced } from "../domain/reservation.ts";
import type { SalesDeps } from "./ports.ts";

export async function cancelReservation(deps: SalesDeps, reservationId: string): Promise<void> {
  await deps.uow.run(async (tx) => {
    const locked = await tx.lockReservation(reservationId);
    if (locked === null) {
      throw new SalesError("reservation_not_found", `予約 ${reservationId} は見つかりません`);
    }
    assertPlaced(locked.reservation, "キャンセル");
    await tx.markReservationCancelled(reservationId, deps.now());
  });
}
