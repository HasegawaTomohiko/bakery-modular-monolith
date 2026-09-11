/**
 * 予約注文。
 *
 * 予約は「受付 → 引き渡し」の 2 段階で、**受付時点では売上にしない**。
 * 取りに来られない予約が現実にあるので、受付を売上に数えると売上が水増しされる。
 * 売上が立つのは引き渡し (`fulfillReservation`) の瞬間だけ。
 *
 * 同じ理由で、予約明細は価格を持たない。焼き付けるのは販売が確定する引き渡し時点の価格。
 * ロット (`lotCode`) も持たない。受付時点ではまだ焼いていないため。
 */
import { invalidInput, SalesError } from "./errors.ts";

export type ReservationStatus = "placed" | "fulfilled" | "cancelled";

export type ReservedLine = {
  readonly productId: string;
  readonly pieces: number;
};

export type Reservation = {
  readonly reservationId: string;
  readonly customerName: string;
  readonly pickupDate: string;
  readonly status: ReservationStatus;
};

/** 顧客名は受け渡しの時に呼ぶためのもの。空だと誰の予約か分からない。 */
export function normalizeCustomerName(value: string): string {
  const name = value.trim();
  if (name.length === 0) {
    throw invalidInput("customerName: 予約者名は必須です");
  }
  return name;
}

/**
 * 引き渡し・キャンセルができるのは受付済みの予約だけ。
 * 二重引き渡し (= 二重計上) と、引き渡し済みの予約のキャンセルを防ぐ。
 */
export function assertPlaced(reservation: Reservation, operation: string): void {
  if (reservation.status !== "placed") {
    throw new SalesError(
      "reservation_not_placed",
      `予約 ${reservation.reservationId} は ${reservation.status} なので${operation}できません`,
    );
  }
}

/** 商品ごとの予約個数に畳む。同じ商品が複数行に分かれていてもよい。 */
export function totalByProduct(lines: readonly ReservedLine[]): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) {
    totals.set(line.productId, (totals.get(line.productId) ?? 0) + line.pieces);
  }
  return totals;
}

/**
 * 引き渡し明細が予約内容と一致することを確かめる。
 *
 * ロットは引き渡しの瞬間に決まるので、1 つの予約行が複数ロットに割れてもよい。
 * ただし**商品ごとの合計個数**は予約と一致していなければならない。
 * 数量を変えたいなら、キャンセルして取り直す (履歴として何が起きたかが残る)。
 */
export function assertMatchesReservation(
  reserved: readonly ReservedLine[],
  handedOver: readonly ReservedLine[],
): void {
  const expected = totalByProduct(reserved);
  const actual = totalByProduct(handedOver);

  for (const [productId, expectedPieces] of expected) {
    const actualPieces = actual.get(productId) ?? 0;
    if (actualPieces !== expectedPieces) {
      throw new SalesError(
        "fulfillment_mismatch",
        `商品 ${productId} の引き渡し個数が予約と一致しません (予約 ${expectedPieces} / 引き渡し ${actualPieces})`,
      );
    }
  }
  for (const productId of actual.keys()) {
    if (!expected.has(productId)) {
      throw new SalesError("fulfillment_mismatch", `商品 ${productId} は予約されていません`);
    }
  }
}
