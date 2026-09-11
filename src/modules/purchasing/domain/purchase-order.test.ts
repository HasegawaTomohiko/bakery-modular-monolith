/**
 * 発注・入荷・検収のドメインの単体テスト。DB も HTTP も使わない。
 *
 * 一番固定したいのは「入荷と検収は別」と「数量の差異は正常」の2点。
 */
import { describe, expect, it } from "vitest";
import type { Quantity } from "../../../shared/events.ts";
import { PurchasingError } from "./errors.ts";
import {
  assertCanAccept,
  assertCanReceive,
  assertValidOrderLines,
  assertValidReceiptLines,
  calculateVariances,
  type GoodsReceipt,
  type PurchaseOrder,
  type PurchaseOrderStatus,
  significantVariances,
} from "./purchase-order.ts";

const FLOUR = "aaaaaaaa-0000-4000-8000-000000000001";
const BUTTER = "aaaaaaaa-0000-4000-8000-000000000002";
const YEAST = "aaaaaaaa-0000-4000-8000-000000000003";

const g = (amount: number): Quantity => ({ amount, unit: "g" });

function order(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    purchaseOrderId: "11111111-1111-4111-8111-111111111111",
    supplierId: "22222222-2222-4222-8222-222222222222",
    status: "placed",
    orderedAt: "2026-09-11T00:00:00.000Z",
    // 強力粉 10kg とバター 2kg。単位は基本単位 (g) に正規化して持つ。
    lines: [
      { ingredientId: FLOUR, quantity: g(10_000) },
      { ingredientId: BUTTER, quantity: g(2_000) },
    ],
    ...overrides,
  };
}

function receipt(overrides: Partial<GoodsReceipt> = {}): GoodsReceipt {
  return {
    goodsReceiptId: "33333333-3333-4333-8333-333333333333",
    purchaseOrderId: "11111111-1111-4111-8111-111111111111",
    receivedAt: "2026-09-11T01:00:00.000Z",
    acceptedAt: null,
    lines: [
      {
        ingredientId: FLOUR,
        quantity: g(9_800),
        lotCode: "LOT-A",
        bestBefore: "2026-12-31",
      },
    ],
    ...overrides,
  };
}

describe("発注明細", () => {
  it("同じ原材料を2行に分けて書けない", () => {
    expect(() =>
      assertValidOrderLines([
        { ingredientId: FLOUR, quantity: g(5_000) },
        { ingredientId: FLOUR, quantity: g(5_000) },
      ]),
    ).toThrow("同じ原材料が重複");
  });

  it("数量が 0 以下の行は書けない", () => {
    expect(() => assertValidOrderLines([{ ingredientId: FLOUR, quantity: g(0) }])).toThrow(
      "正の値",
    );
  });

  it("空の発注は作れない", () => {
    expect(() => assertValidOrderLines([])).toThrow("1行以上");
  });
});

describe("入荷できる状態か", () => {
  it("placed なら入荷できる", () => {
    expect(() => assertCanReceive(order({ status: "placed" }))).not.toThrow();
  });

  // 二重入荷や、検収済みの発注への後づけ入荷を弾く。
  it.each<PurchaseOrderStatus>(["received", "accepted", "cancelled"])(
    "%s には入荷を登録できない",
    (status) => {
      expect(() => assertCanReceive(order({ status }))).toThrow(PurchasingError);
    },
  );
});

describe("入荷明細", () => {
  it("発注と数量が違っても受け付ける", () => {
    // 10kg 頼んで 9.8kg。これは日常であってエラーではない。
    expect(() => assertValidReceiptLines(order(), receipt().lines)).not.toThrow();
  });

  it("発注していない原材料は受け付けない", () => {
    expect(() =>
      assertValidReceiptLines(order(), [
        { ingredientId: YEAST, quantity: g(500), lotCode: "LOT-Y", bestBefore: "2026-10-01" },
      ]),
    ).toThrow("発注 11111111-1111-4111-8111-111111111111 に無い原材料");
  });

  it("単位が発注と違うと受け付けない", () => {
    // 差異が計算できなくなるので、これは記録の誤りとして弾く。
    expect(() =>
      assertValidReceiptLines(order(), [
        {
          ingredientId: FLOUR,
          quantity: { amount: 10, unit: "piece" },
          lotCode: "LOT-A",
          bestBefore: "2026-12-31",
        },
      ]),
    ).toThrow("単位が発注と違います");
  });

  it("ロット番号は必須", () => {
    expect(() =>
      assertValidReceiptLines(order(), [
        { ingredientId: FLOUR, quantity: g(9_800), lotCode: "  ", bestBefore: "2026-12-31" },
      ]),
    ).toThrow("ロット番号は必須");
  });
});

describe("数量の差異", () => {
  it("不足を負の差として出す", () => {
    const variances = calculateVariances(order(), receipt().lines);

    expect(variances).toHaveLength(2);
    expect(variances[0]).toMatchObject({
      ingredientId: FLOUR,
      ordered: g(10_000),
      received: g(9_800),
      difference: g(-200),
    });
  });

  it("入荷しなかった行は 0 として並べる (欠品も差異)", () => {
    const variances = calculateVariances(order(), receipt().lines);

    expect(variances[1]).toMatchObject({
      ingredientId: BUTTER,
      received: g(0),
      difference: g(-2_000),
    });
  });

  it("過納は正の差になる", () => {
    const variances = calculateVariances(order(), [
      { ingredientId: FLOUR, quantity: g(10_500), lotCode: "L", bestBefore: "2026-12-31" },
    ]);

    expect(variances[0]?.difference).toEqual(g(500));
  });

  it("差異のある行だけを絞れる", () => {
    const exact = calculateVariances(order(), [
      { ingredientId: FLOUR, quantity: g(10_000), lotCode: "L", bestBefore: "2026-12-31" },
      { ingredientId: BUTTER, quantity: g(2_000), lotCode: "L", bestBefore: "2026-12-31" },
    ]);

    expect(significantVariances(exact)).toHaveLength(0);
  });

  it("小数の足し引きで誤差を出さない", () => {
    // 0.1 + 0.2 が 0.30000000000000004 になる類の誤差を丸めで吸収する。
    const variances = calculateVariances(
      order({ lines: [{ ingredientId: FLOUR, quantity: { amount: 0.3, unit: "g" } }] }),
      [
        {
          ingredientId: FLOUR,
          quantity: { amount: 0.1, unit: "g" },
          lotCode: "L",
          bestBefore: "2026-12-31",
        },
      ],
    );

    expect(variances[0]?.difference.amount).toBe(-0.2);
  });
});

describe("検収できる状態か", () => {
  it("未検収なら検収できる", () => {
    expect(() => assertCanAccept(receipt())).not.toThrow();
  });

  it("二重検収は弾く", () => {
    // ここが緩いと inventory が同じ入庫を2回することになる。
    expect(() => assertCanAccept(receipt({ acceptedAt: "2026-09-11T02:00:00.000Z" }))).toThrow(
      "既に",
    );
  });

  it("明細の無い入荷は検収できない", () => {
    expect(() => assertCanAccept(receipt({ lines: [] }))).toThrow("明細がありません");
  });
});
