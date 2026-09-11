/**
 * 製造計画のドメインテスト。
 *
 * basis (なぜその数にしたか) が数量と同じ重みで残ることを固定する。
 * ここが落ちると、計画の良し悪しを後から検証できなくなる。
 */
import { describe, expect, it } from "vitest";
import type { Quantity } from "../../../shared/events.ts";
import {
  isPlanBasis,
  type ProductionPlanItem,
  validatePlanItems,
  withoutProducts,
} from "./production-plan.ts";

const CROISSANT = "11111111-1111-4111-8111-111111111111";
const BAGUETTE = "22222222-2222-4222-8222-222222222222";
const RECIPE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const pieces = (amount: number): Quantity => ({ amount, unit: "piece" });

const item = (
  productId: string,
  plannedQuantity: number,
  basis: ProductionPlanItem["basis"],
): ProductionPlanItem => ({
  productId,
  recipeId: RECIPE,
  plannedQuantity: pieces(plannedQuantity),
  basis,
});

describe("validatePlanItems", () => {
  it("3 種類の根拠をすべて受け付ける", () => {
    const items = [
      item(CROISSANT, 40, "forecast"),
      item(BAGUETTE, 12, "reservation"),
      item("33333333-3333-4333-8333-333333333333", 6, "manual"),
    ];
    expect(() => validatePlanItems(items)).not.toThrow();
    // 同じ 40 でも「予測で 40」と「予約が 40」は意味が違う。値が保たれること。
    expect(items.map((entry) => entry.basis)).toEqual(["forecast", "reservation", "manual"]);
  });

  it("同じ商品を 2 行に分けられない", () => {
    expect(() =>
      validatePlanItems([item(CROISSANT, 20, "forecast"), item(CROISSANT, 20, "manual")]),
    ).toThrow("同じ商品が 2 行");
  });

  it("計画数は整数の個数", () => {
    expect(() => validatePlanItems([item(CROISSANT, 2.5, "forecast")])).toThrow("整数である必要");
    expect(() =>
      validatePlanItems([
        { ...item(CROISSANT, 20, "forecast"), plannedQuantity: { amount: 20, unit: "g" } },
      ]),
    ).toThrow("個数 (piece) で指定");
  });

  it("根拠が契約外の値なら弾く", () => {
    expect(() =>
      validatePlanItems([
        { ...item(CROISSANT, 20, "forecast"), basis: "なんとなく" as ProductionPlanItem["basis"] },
      ]),
    ).toThrow("計画の根拠が不正");
  });
});

describe("isPlanBasis", () => {
  it("契約にある根拠だけを真とする", () => {
    expect(isPlanBasis("forecast")).toBe(true);
    expect(isPlanBasis("reservation")).toBe(true);
    expect(isPlanBasis("manual")).toBe(true);
    expect(isPlanBasis("guess")).toBe(false);
  });
});

describe("withoutProducts", () => {
  it("販売停止の商品だけを外し、他は順序ごと残す", () => {
    const items = [item(CROISSANT, 40, "forecast"), item(BAGUETTE, 12, "reservation")];
    expect(withoutProducts(items, new Set([CROISSANT]))).toEqual([items[1]]);
  });

  it("該当が無ければそのまま", () => {
    const items = [item(CROISSANT, 40, "forecast")];
    expect(withoutProducts(items, new Set())).toEqual(items);
  });
});
