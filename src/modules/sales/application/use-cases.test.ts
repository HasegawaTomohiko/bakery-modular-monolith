/**
 * ユースケースの単体テスト (DB 不要)。
 *
 * ポート (ports.ts) をインメモリ実装に差し替えて、業務のルールだけを見る。
 * DB を挟んで初めて確かめられること (outbox に同じトランザクションで載るか、
 * relay で購読側に届くか) は tests/integration/sales.test.ts の担当。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { EventPayload } from "../../../shared/events.ts";
import type { Reservation, ReservedLine } from "../domain/reservation.ts";
import type { Sale } from "../domain/sale.ts";
import { cancelReservation } from "./cancel-reservation.ts";
import { fulfillReservation } from "./fulfill-reservation.ts";
import { handleProductDelisted } from "./handle-product-delisted.ts";
import { placeReservation } from "./place-reservation.ts";
import type { DailySalesRow, SalesDeps, SalesTx } from "./ports.ts";
import { getDailySales, listReservations } from "./queries.ts";
import { recordSale } from "./record-sale.ts";

const CROISSANT = "11111111-1111-4111-8111-111111111111";
const BAGUETTE = "22222222-2222-4222-8222-222222222222";

/** インメモリの sales。トランザクションの中身は見ないので run はそのまま実行する。 */
function createFakeSales() {
  const sales: Sale[] = [];
  const reservations = new Map<string, { reservation: Reservation; lines: ReservedLine[] }>();
  const unsellable = new Set<string>();
  const published: EventPayload<"sales.SaleCompleted">[] = [];
  let sequence = 0;

  const tx: SalesTx = {
    async insertSale(sale) {
      sales.push(sale);
    },
    async findUnsellableProducts(productIds) {
      return productIds.filter((productId) => unsellable.has(productId));
    },
    async insertReservation(reservation) {
      reservations.set(reservation.reservationId, {
        reservation: {
          reservationId: reservation.reservationId,
          customerName: reservation.customerName,
          pickupDate: reservation.pickupDate,
          status: "placed",
        },
        lines: [...reservation.lines],
      });
    },
    async lockReservation(reservationId) {
      return reservations.get(reservationId) ?? null;
    },
    async markReservationFulfilled(reservationId) {
      const found = reservations.get(reservationId);
      if (found !== undefined) {
        found.reservation = { ...found.reservation, status: "fulfilled" };
      }
    },
    async markReservationCancelled(reservationId) {
      const found = reservations.get(reservationId);
      if (found !== undefined) {
        found.reservation = { ...found.reservation, status: "cancelled" };
      }
    },
    async listReservations(pickupDate) {
      return [...reservations.values()]
        .map((entry) => entry.reservation)
        .filter((reservation) => reservation.pickupDate === pickupDate);
    },
    async aggregateDailySales(businessDate): Promise<readonly DailySalesRow[]> {
      const totals = new Map<string, DailySalesRow>();
      for (const sale of sales.filter((candidate) => candidate.businessDate === businessDate)) {
        for (const line of sale.lines) {
          const current = totals.get(line.productId);
          totals.set(line.productId, {
            productId: line.productId,
            soldPieces: (current?.soldPieces ?? 0) + line.pieces,
            subtotalJpy: (current?.subtotalJpy ?? 0) + line.subtotalJpy,
          });
        }
      }
      return [...totals.values()].sort((a, b) => a.productId.localeCompare(b.productId));
    },
    async publishSaleCompleted(payload) {
      published.push(payload);
    },
  };

  // catalog の代役。価格と販売可否だけを返す。
  const catalogProducts = new Map<string, { priceJpy: number; sellable: boolean }>([
    [CROISSANT, { priceJpy: 280, sellable: true }],
    [BAGUETTE, { priceJpy: 320, sellable: true }],
  ]);

  const deps: SalesDeps = {
    uow: { run: (work) => work(tx) },
    products: {
      async getProduct(productId) {
        return catalogProducts.get(productId) ?? null;
      },
    },
    newId: () => {
      sequence += 1;
      return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
    },
    now: () => new Date("2026-09-11T10:00:00+09:00"),
  };

  return { deps, tx, sales, reservations, unsellable, published, catalogProducts };
}

type FakeSales = ReturnType<typeof createFakeSales>;

let fake: FakeSales;

beforeEach(() => {
  fake = createFakeSales();
});

const storefrontSale = {
  soldAt: "2026-09-11T07:42:00+09:00",
  lines: [
    { productId: CROISSANT, lotCode: "CRO-20260911-01", quantity: { amount: 2, unit: "piece" } },
  ],
} as const;

describe("recordSale", () => {
  it("販売時点の価格を焼き付けて sales.SaleCompleted を積む", async () => {
    const saleId = await recordSale(fake.deps, storefrontSale);

    expect(fake.sales[0]?.totalJpy).toBe(560);
    expect(fake.published).toEqual([
      {
        saleId,
        channel: "storefront",
        soldAt: "2026-09-10T22:42:00.000Z",
        lines: [
          {
            productId: CROISSANT,
            lotCode: "CRO-20260911-01",
            quantity: { amount: 2, unit: "piece" },
            unitPriceJpy: 280,
          },
        ],
        totalJpy: 560,
      },
    ]);
  });

  it("catalog の価格が後から変わっても、記録済みの売上は動かない", async () => {
    await recordSale(fake.deps, storefrontSale);
    fake.catalogProducts.set(CROISSANT, { priceJpy: 300, sellable: true });

    expect(fake.sales[0]?.lines[0]?.unitPriceJpy).toBe(280);
    const daily = await getDailySales(fake.deps, "2026-09-11");
    expect(daily.totalJpy).toBe(560);
  });

  it("販売停止中の商品は売れない (参照コピーで弾く)", async () => {
    fake.unsellable.add(CROISSANT);

    await expect(recordSale(fake.deps, storefrontSale)).rejects.toThrow(/販売停止中/);
    expect(fake.sales).toHaveLength(0);
    expect(fake.published).toHaveLength(0);
  });

  it("catalog に無い商品は売れない", async () => {
    await expect(
      recordSale(fake.deps, {
        soldAt: storefrontSale.soldAt,
        lines: [
          {
            productId: "33333333-3333-4333-8333-333333333333",
            lotCode: "X-1",
            quantity: { amount: 1, unit: "piece" },
          },
        ],
      }),
    ).rejects.toThrow(/catalog にありません/);
  });

  it("soldAt がオフセット無しなら受け付けない", async () => {
    await expect(
      recordSale(fake.deps, { ...storefrontSale, soldAt: "2026-09-11 07:42" }),
    ).rejects.toThrow(/ISO 日時/);
  });
});

describe("予約", () => {
  const reservationInput = {
    customerName: "山田",
    pickupDate: "2026-09-12",
    lines: [{ productId: CROISSANT, quantity: { amount: 3, unit: "piece" } }],
  } as const;

  it("受付では売上が立たず、イベントも出ない", async () => {
    const reservationId = await placeReservation(fake.deps, reservationInput);

    expect(fake.sales).toHaveLength(0);
    expect(fake.published).toHaveLength(0);
    expect(await listReservations(fake.deps, "2026-09-12")).toEqual([
      { reservationId, customerName: "山田", pickupDate: "2026-09-12", status: "placed" },
    ]);
  });

  it("引き渡しで初めて売上が立ち、channel=reservation で発行する", async () => {
    const reservationId = await placeReservation(fake.deps, reservationInput);

    const saleId = await fulfillReservation(fake.deps, {
      reservationId,
      fulfilledAt: "2026-09-12T08:00:00+09:00",
      // ロットは引き渡しの瞬間に決まる。2 ロットに割れてもよい。
      lines: [
        {
          productId: CROISSANT,
          lotCode: "CRO-20260912-01",
          quantity: { amount: 2, unit: "piece" },
        },
        {
          productId: CROISSANT,
          lotCode: "CRO-20260912-02",
          quantity: { amount: 1, unit: "piece" },
        },
      ],
    });

    expect(fake.published[0]?.channel).toBe("reservation");
    expect(fake.published[0]?.saleId).toBe(saleId);
    expect(fake.published[0]?.totalJpy).toBe(840);
    expect(fake.sales[0]?.reservationId).toBe(reservationId);
    // 売上は引き渡した日に立つ
    expect((await getDailySales(fake.deps, "2026-09-12")).totalJpy).toBe(840);
    expect((await getDailySales(fake.deps, "2026-09-11")).totalJpy).toBe(0);
  });

  it("同じ予約を 2 回引き渡せない (売上の二重計上を防ぐ)", async () => {
    const reservationId = await placeReservation(fake.deps, reservationInput);
    const handover = {
      reservationId,
      fulfilledAt: "2026-09-12T08:00:00+09:00",
      lines: [{ productId: CROISSANT, lotCode: "CRO-1", quantity: { amount: 3, unit: "piece" } }],
    } as const;

    await fulfillReservation(fake.deps, handover);
    await expect(fulfillReservation(fake.deps, handover)).rejects.toThrow(/fulfilled/);
    expect(fake.published).toHaveLength(1);
  });

  it("予約と違う個数は引き渡せない", async () => {
    const reservationId = await placeReservation(fake.deps, reservationInput);

    await expect(
      fulfillReservation(fake.deps, {
        reservationId,
        fulfilledAt: "2026-09-12T08:00:00+09:00",
        lines: [{ productId: CROISSANT, lotCode: "CRO-1", quantity: { amount: 2, unit: "piece" } }],
      }),
    ).rejects.toThrow(/一致しません/);
  });

  it("受付済みの予約はキャンセルでき、キャンセル後は引き渡せない", async () => {
    const reservationId = await placeReservation(fake.deps, reservationInput);

    await cancelReservation(fake.deps, reservationId);

    expect((await listReservations(fake.deps, "2026-09-12"))[0]?.status).toBe("cancelled");
    await expect(
      fulfillReservation(fake.deps, {
        reservationId,
        fulfilledAt: "2026-09-12T08:00:00+09:00",
        lines: [{ productId: CROISSANT, lotCode: "CRO-1", quantity: { amount: 3, unit: "piece" } }],
      }),
    ).rejects.toThrow(/cancelled/);
    // キャンセルは売上に影響しない (受付を売上にしていないので取り消すものがない)
    expect(fake.sales).toHaveLength(0);
  });

  it("無い予約は引き渡せない", async () => {
    await expect(
      fulfillReservation(fake.deps, {
        reservationId: "44444444-4444-4444-8444-444444444444",
        fulfilledAt: "2026-09-12T08:00:00+09:00",
        lines: [{ productId: CROISSANT, lotCode: "CRO-1", quantity: { amount: 1, unit: "piece" } }],
      }),
    ).rejects.toThrow(/見つかりません/);
  });

  it("販売停止中の商品は新規に予約できないが、受付済みの予約は引き渡せる", async () => {
    const reservationId = await placeReservation(fake.deps, reservationInput);
    // 受付後に販売停止になった
    fake.unsellable.add(CROISSANT);
    fake.catalogProducts.set(CROISSANT, { priceJpy: 280, sellable: false });

    await expect(placeReservation(fake.deps, reservationInput)).rejects.toThrow(/販売停止中/);
    // 客との約束が先。引き渡しは通る。
    await expect(
      fulfillReservation(fake.deps, {
        reservationId,
        fulfilledAt: "2026-09-12T08:00:00+09:00",
        lines: [{ productId: CROISSANT, lotCode: "CRO-1", quantity: { amount: 3, unit: "piece" } }],
      }),
    ).resolves.toBeTypeOf("string");
  });
});

describe("getDailySales", () => {
  it("商品ごとに個数と小計を積み上げる", async () => {
    await recordSale(fake.deps, {
      soldAt: "2026-09-11T07:42:00+09:00",
      lines: [
        { productId: CROISSANT, lotCode: "CRO-1", quantity: { amount: 2, unit: "piece" } },
        { productId: BAGUETTE, lotCode: "BAG-1", quantity: { amount: 1, unit: "piece" } },
      ],
    });
    await recordSale(fake.deps, {
      soldAt: "2026-09-11T15:00:00+09:00",
      lines: [{ productId: CROISSANT, lotCode: "CRO-2", quantity: { amount: 1, unit: "piece" } }],
    });
    // 日跨ぎ: JST では翌日なので集計に入らない
    await recordSale(fake.deps, {
      soldAt: "2026-09-11T22:00:00Z",
      lines: [{ productId: CROISSANT, lotCode: "CRO-3", quantity: { amount: 5, unit: "piece" } }],
    });

    const daily = await getDailySales(fake.deps, "2026-09-11");

    expect(daily).toEqual({
      businessDate: "2026-09-11",
      totalJpy: 1160,
      byProduct: [
        { productId: CROISSANT, soldQuantity: { amount: 3, unit: "piece" }, subtotalJpy: 840 },
        { productId: BAGUETTE, soldQuantity: { amount: 1, unit: "piece" }, subtotalJpy: 320 },
      ],
    });
  });

  it("売上が無い日は 0 円", async () => {
    expect(await getDailySales(fake.deps, "2026-09-11")).toEqual({
      businessDate: "2026-09-11",
      totalJpy: 0,
      byProduct: [],
    });
  });
});

describe("handleProductDelisted", () => {
  it("参照コピーに販売停止を写し取る", async () => {
    const written: { productId: string; delistedAt: Date; reason: string }[] = [];

    await handleProductDelisted(
      {
        async markDelisted(productId, delistedAt, reason) {
          written.push({ productId, delistedAt, reason });
        },
      },
      {
        productId: CROISSANT,
        delistedAt: "2026-09-11T09:00:00+09:00",
        reason: "seasonal",
      },
    );

    expect(written).toEqual([
      {
        productId: CROISSANT,
        delistedAt: new Date("2026-09-11T09:00:00+09:00"),
        reason: "seasonal",
      },
    ]);
  });
});
