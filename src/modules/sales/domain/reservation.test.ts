import { describe, expect, it } from "vitest";
import { SalesError } from "./errors.ts";
import {
  assertMatchesReservation,
  assertPlaced,
  normalizeCustomerName,
  type Reservation,
} from "./reservation.ts";

const CROISSANT = "11111111-1111-4111-8111-111111111111";
const BAGUETTE = "22222222-2222-4222-8222-222222222222";

const reservation = (status: Reservation["status"]): Reservation => ({
  reservationId: "reservation-1",
  customerName: "山田",
  pickupDate: "2026-09-12",
  status,
});

describe("normalizeCustomerName", () => {
  it("前後の空白を落とす", () => {
    expect(normalizeCustomerName("  山田  ")).toBe("山田");
  });

  it("空の名前は受け付けない", () => {
    expect(() => normalizeCustomerName("   ")).toThrow(SalesError);
  });
});

describe("assertPlaced", () => {
  it("受付済みなら通る", () => {
    expect(() => assertPlaced(reservation("placed"), "引き渡し")).not.toThrow();
  });

  it("引き渡し済みの予約は二重に引き渡せない", () => {
    expect(() => assertPlaced(reservation("fulfilled"), "引き渡し")).toThrow(/fulfilled/);
  });

  it("キャンセル済みの予約は操作できない", () => {
    expect(() => assertPlaced(reservation("cancelled"), "キャンセル")).toThrow(/cancelled/);
  });
});

describe("assertMatchesReservation", () => {
  const reserved = [{ productId: CROISSANT, pieces: 3 }];

  it("ロットが分かれていても商品ごとの合計が合えばよい", () => {
    expect(() =>
      assertMatchesReservation(reserved, [
        { productId: CROISSANT, pieces: 2 },
        { productId: CROISSANT, pieces: 1 },
      ]),
    ).not.toThrow();
  });

  it("個数が足りなければ落とす", () => {
    expect(() => assertMatchesReservation(reserved, [{ productId: CROISSANT, pieces: 2 }])).toThrow(
      /一致しません/,
    );
  });

  it("予約されていない商品は渡せない", () => {
    expect(() =>
      assertMatchesReservation(reserved, [
        { productId: CROISSANT, pieces: 3 },
        { productId: BAGUETTE, pieces: 1 },
      ]),
    ).toThrow(/予約されていません/);
  });
});
