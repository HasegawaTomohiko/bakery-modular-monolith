import { describe, expect, it } from "vitest";
import { buildSale, toSaleCompletedPayload } from "./sale.ts";

const CROISSANT = "11111111-1111-4111-8111-111111111111";
const BAGUETTE = "22222222-2222-4222-8222-222222222222";

const prices: Record<string, number> = { [CROISSANT]: 280, [BAGUETTE]: 320 };
const unitPriceOf = (productId: string): number => prices[productId] ?? 0;

describe("buildSale", () => {
  it("販売時点の単価で小計と合計を出す", () => {
    const sale = buildSale({
      saleId: "sale-1",
      channel: "storefront",
      soldAt: new Date("2026-09-11T07:42:00+09:00"),
      reservationId: null,
      lines: [
        { productId: CROISSANT, lotCode: "CRO-1", pieces: 2 },
        { productId: BAGUETTE, lotCode: "BAG-1", pieces: 1 },
      ],
      unitPriceOf,
    });

    expect(sale.lines[0]?.subtotalJpy).toBe(560);
    expect(sale.totalJpy).toBe(880);
    // 営業日は soldAt から導く。集計のたびに計算し直さない。
    expect(sale.businessDate).toBe("2026-09-11");
  });

  it("明細が空なら落とす", () => {
    expect(() =>
      buildSale({
        saleId: "sale-1",
        channel: "storefront",
        soldAt: new Date(),
        reservationId: null,
        lines: [],
        unitPriceOf,
      }),
    ).toThrow(/明細が空/);
  });
});

describe("toSaleCompletedPayload", () => {
  it("受け手が必要とする分だけを載せる (顧客名や予約 ID は載せない)", () => {
    const sale = buildSale({
      saleId: "sale-1",
      channel: "reservation",
      soldAt: new Date("2026-09-11T07:42:00+09:00"),
      reservationId: "reservation-1",
      lines: [{ productId: CROISSANT, lotCode: "CRO-1", pieces: 2 }],
      unitPriceOf,
    });

    const payload = toSaleCompletedPayload(sale);

    expect(payload).toEqual({
      saleId: "sale-1",
      channel: "reservation",
      soldAt: "2026-09-10T22:42:00.000Z",
      lines: [
        {
          productId: CROISSANT,
          lotCode: "CRO-1",
          quantity: { amount: 2, unit: "piece" },
          unitPriceJpy: 280,
        },
      ],
      totalJpy: 560,
    });
    expect(Object.keys(payload)).not.toContain("reservationId");
  });
});
