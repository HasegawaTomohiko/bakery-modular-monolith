/**
 * レシピのドメインテスト。
 *
 * ここが production の一番の肝で、「レシピ × 実際に焼けた数量」の算出結果が
 * そのまま inventory の在庫を減らす値になる (production.ProductionCompleted の
 * consumedIngredients)。間違えると在庫が静かにずれ続ける。
 */
import { describe, expect, it } from "vitest";
import type { Quantity } from "../../../shared/events.ts";
import { consumptionFor, type Recipe, requiredBatches, validateRecipeDraft } from "./recipe.ts";

const FLOUR = "33333333-3333-4333-8333-333333333333";
const BUTTER = "44444444-4444-4444-8444-444444444444";
const PRODUCT = "11111111-1111-4111-8111-111111111111";

const pieces = (amount: number): Quantity => ({ amount, unit: "piece" });
const grams = (amount: number): Quantity => ({ amount, unit: "g" });

/** 1 バッチ 20 個取り。強力粉 1200g とバター 600g。 */
const croissant: Recipe = {
  recipeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  productId: PRODUCT,
  version: 1,
  yieldQuantity: pieces(20),
  lines: [
    { ingredientId: FLOUR, quantity: grams(1200) },
    { ingredientId: BUTTER, quantity: grams(600) },
  ],
  registeredAt: new Date("2026-09-01T00:00:00Z"),
};

describe("requiredBatches", () => {
  it("ちょうど 1 バッチ分なら 1 バッチ", () => {
    expect(requiredBatches(croissant, pieces(20))).toBe(1);
  });

  it("20 個取りで 24 個焼いたら 2 バッチ (切り上げ)", () => {
    // 生地はバッチ単位でしか仕込めない。ミキサーは 2 回回っている。
    expect(requiredBatches(croissant, pieces(24))).toBe(2);
  });

  it("1 個でも 1 バッチ分の原材料が要る", () => {
    expect(requiredBatches(croissant, pieces(1))).toBe(1);
  });

  it("バッチの倍数ならそのままの倍数", () => {
    expect(requiredBatches(croissant, pieces(60))).toBe(3);
  });
});

describe("consumptionFor", () => {
  it("レシピ × バッチ数で消費量を出す", () => {
    expect(consumptionFor(croissant, pieces(40))).toEqual([
      { ingredientId: FLOUR, quantity: grams(2400) },
      { ingredientId: BUTTER, quantity: grams(1200) },
    ]);
  });

  it("端数は切り上げたバッチ数で計算する (比例配分しない)", () => {
    // 1.2 倍 (1440g / 720g) ではなく 2 バッチ分。比例配分にすると帳簿上の
    // 消費が実際より少なくなり、在庫が同じ向きにずれ続ける。
    expect(consumptionFor(croissant, pieces(24))).toEqual([
      { ingredientId: FLOUR, quantity: grams(2400) },
      { ingredientId: BUTTER, quantity: grams(1200) },
    ]);
  });

  it("単位は基本単位のまま運ぶ (受け手に換算させない)", () => {
    const consumed = consumptionFor(croissant, pieces(20));
    expect(consumed.every((line) => line.quantity.unit === "g")).toBe(true);
  });

  it("個数以外で焼き上がりを渡すと弾く", () => {
    expect(() => consumptionFor(croissant, grams(24))).toThrow("個数 (piece) で指定");
  });
});

describe("validateRecipeDraft", () => {
  const draft = {
    productId: PRODUCT,
    yieldQuantity: pieces(20),
    lines: [{ ingredientId: FLOUR, quantity: grams(1200) }],
  };

  it("原材料が 1 つ以上あれば通る", () => {
    expect(() => validateRecipeDraft(draft)).not.toThrow();
  });

  it("同じ原材料を 2 行に書けない", () => {
    // 2 行あると「レシピ × バッチ数」の合計がどちらの行なのか曖昧になる。
    expect(() =>
      validateRecipeDraft({
        ...draft,
        lines: [
          { ingredientId: FLOUR, quantity: grams(1200) },
          { ingredientId: FLOUR, quantity: grams(300) },
        ],
      }),
    ).toThrow("同じ原材料が 2 行");
  });

  it("1 バッチで 0.5 個しか焼けないレシピは無い", () => {
    expect(() => validateRecipeDraft({ ...draft, yieldQuantity: pieces(0.5) })).toThrow(
      "整数である必要",
    );
  });

  it("分量 0 の原材料は書けない", () => {
    expect(() =>
      validateRecipeDraft({ ...draft, lines: [{ ingredientId: FLOUR, quantity: grams(0) }] }),
    ).toThrow("正の数量");
  });
});
