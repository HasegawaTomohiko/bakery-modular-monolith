/**
 * 製造実績のドメインテスト。
 *
 * 計画数と実績数の両方を持つ意味は、差分が取れること。
 * 「40 個計画して 36 個」と「0 個計画して 36 個 (計画外)」は別の話として読めること。
 */
import { describe, expect, it } from "vitest";
import type { Quantity } from "../../../shared/events.ts";
import { type ProductionRun, quantityVariance } from "./production-run.ts";

const pieces = (amount: number): Quantity => ({ amount, unit: "piece" });

const run = (planned: number, produced: number): ProductionRun => ({
  productionRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  productionPlanId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  productId: "11111111-1111-4111-8111-111111111111",
  recipeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  plannedQuantity: pieces(planned),
  producedQuantity: pieces(produced),
  lotCode: "CR-20260912-01",
  bestBefore: "2026-09-12",
  completedAt: "2026-09-12T06:30:00+09:00",
  consumedIngredients: [],
});

describe("quantityVariance", () => {
  it("足りなければ負", () => {
    expect(quantityVariance(run(40, 36))).toBe(-4);
  });

  it("焼きすぎれば正 (バッチの丸めで起こりうる)", () => {
    expect(quantityVariance(run(24, 40))).toBe(16);
  });

  it("計画どおりなら 0", () => {
    expect(quantityVariance(run(40, 40))).toBe(0);
  });

  it("計画外の製造は計画数 0 なので実績がそのまま差分になる", () => {
    expect(quantityVariance(run(0, 36))).toBe(36);
  });
});
