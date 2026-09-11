/**
 * FEFO の払い出し。在庫が足りなくても例外にしないことが一番の関心事。
 */
import { describe, expect, it } from "vitest";
import {
  allocateFefo,
  expiredLots,
  type IngredientLot,
  nearestBestBefore,
} from "./ingredient-lot.ts";

const lot = (lotId: string, bestBefore: string, remaining: number): IngredientLot => ({
  lotId,
  ingredientId: "aaaaaaaa-0000-4000-8000-000000000001",
  lotCode: `LOT-${lotId}`,
  bestBefore,
  remaining: { amount: remaining, unit: "g" },
  receivedAt: "2026-09-01T00:00:00.000Z",
});

describe("allocateFefo", () => {
  it("賞味期限の早いロットから払い出す (後から入ったものでも)", () => {
    // FIFO ではなく FEFO。原材料の廃棄は期限切れで起きるため。
    const lots = [lot("new", "2026-09-20", 1000), lot("soon", "2026-09-12", 800)];

    const result = allocateFefo(lots, { amount: 1000, unit: "g" });

    expect(result.allocations).toEqual([
      { lotId: "soon", consumed: { amount: 800, unit: "g" }, remaining: { amount: 0, unit: "g" } },
      { lotId: "new", consumed: { amount: 200, unit: "g" }, remaining: { amount: 800, unit: "g" } },
    ]);
    expect(result.shortfall).toEqual({ amount: 0, unit: "g" });
  });

  it("足りなくても例外にせず不足分を返す", () => {
    // 結果整合なので、製造完了が入荷検収より先に届くことがある。
    const result = allocateFefo([lot("only", "2026-09-12", 300)], { amount: 500, unit: "g" });

    expect(result.allocations).toHaveLength(1);
    expect(result.shortfall).toEqual({ amount: 200, unit: "g" });
  });

  it("ロットが1つも無ければ全量が不足になる", () => {
    expect(allocateFefo([], { amount: 500, unit: "g" }).shortfall).toEqual({
      amount: 500,
      unit: "g",
    });
  });
});

describe("nearestBestBefore / expiredLots", () => {
  it("残量のあるロットの中で最も早い期限を返す", () => {
    const lots = [lot("empty", "2026-09-01", 0), lot("live", "2026-09-12", 500)];
    expect(nearestBestBefore(lots)).toBe("2026-09-12");
  });

  it("残量が無ければ null", () => {
    expect(nearestBestBefore([lot("empty", "2026-09-01", 0)])).toBeNull();
  });

  it("当日より前に切れていて残量のあるロットだけを期限切れとする", () => {
    const lots = [lot("old", "2026-09-10", 200), lot("today", "2026-09-11", 200)];
    expect(expiredLots(lots, "2026-09-11").map((found) => found.lotId)).toEqual(["old"]);
  });
});
