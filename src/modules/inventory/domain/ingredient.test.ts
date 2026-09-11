/**
 * 発注点の判定。ここで見たいのは「いつ発行するか」の一点。
 */
import { describe, expect, it } from "vitest";
import { evaluateReorderPoint, type Ingredient, suggestOrderQuantity } from "./ingredient.ts";

const flour = (onHand: number, belowReorderPoint: boolean): Ingredient => ({
  ingredientId: "aaaaaaaa-0000-4000-8000-000000000001",
  name: "強力粉",
  unit: "g",
  onHand: { amount: onHand, unit: "g" },
  reorderPoint: { amount: 5000, unit: "g" },
  belowReorderPoint,
});

describe("evaluateReorderPoint", () => {
  it("上回っている間は発行しない", () => {
    const evaluation = evaluateReorderPoint(flour(8000, false));
    expect(evaluation.belowNow).toBe(false);
    expect(evaluation.breached).toBe(false);
  });

  it("発注点ちょうどは割れていない (下回る = 厳密に小さい)", () => {
    expect(evaluateReorderPoint(flour(5000, false)).belowNow).toBe(false);
  });

  it("上回る → 下回る に変わった瞬間だけ発行する", () => {
    expect(evaluateReorderPoint(flour(4999, false)).breached).toBe(true);
  });

  it("下回っている間ずっとは発行しない", () => {
    // 消費のたびに提案が飛ぶと purchasing 側の一覧が使い物にならない。
    const evaluation = evaluateReorderPoint(flour(100, true));
    expect(evaluation.belowNow).toBe(true);
    expect(evaluation.breached).toBe(false);
  });

  it("在庫がマイナスでも判定は同じ (例外にしない)", () => {
    expect(evaluateReorderPoint(flour(-200, true)).breached).toBe(false);
    expect(evaluateReorderPoint(flour(-200, false)).breached).toBe(true);
  });
});

describe("suggestOrderQuantity", () => {
  it("発注点の2倍まで戻す量を提案する", () => {
    // 発注点ちょうどまでしか戻さないと、届いた翌日にまた割れる。
    expect(suggestOrderQuantity({ amount: 1000, unit: "g" }, { amount: 5000, unit: "g" })).toEqual({
      amount: 9000,
      unit: "g",
    });
  });

  it("在庫がマイナスなら不足分も込みで提案する", () => {
    expect(suggestOrderQuantity({ amount: -500, unit: "g" }, { amount: 5000, unit: "g" })).toEqual({
      amount: 10500,
      unit: "g",
    });
  });
});
