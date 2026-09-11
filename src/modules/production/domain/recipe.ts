/**
 * レシピ。
 *
 * production にとっての「クロワッサン」は、原材料と分量を持つレシピであって、
 * catalog の販売物 (名前・価格・アレルゲン表示) でも inventory のロットでもない。
 * ここに商品名や価格を持たせないこと。必要なら catalog に同期で問い合わせる。
 *
 * **レシピは更新せず、新しい版を作る。** 配合を変えた後で過去の製造実績を見たとき、
 * 当時の配合が分からないと原価も歩留まりも追えないため。製造実績は recipeId
 * (= 版そのものの ID) を持つので、何年前の実績でも当時の配合に辿り着ける。
 */
import type { Quantity } from "../../../shared/events.ts";
import { ProductionValidationError } from "./errors.ts";
import { assertIngredientAmount, assertPieces, scaleQuantity } from "./quantity.ts";

export type RecipeLine = {
  /** inventory の原材料識別子。在庫数は inventory に問い合わせる。 */
  readonly ingredientId: string;
  /** 1 バッチあたりの分量。 */
  readonly quantity: Quantity;
};

export type Recipe = {
  readonly recipeId: string;
  /** catalog の商品識別子。 */
  readonly productId: string;
  /** 同じ商品の中での版。1 から始まり、配合を変えるたびに増える。 */
  readonly version: number;
  /** 1 バッチで焼ける個数。 */
  readonly yieldQuantity: Quantity;
  readonly lines: readonly RecipeLine[];
  readonly registeredAt: Date;
};

export type RecipeDraft = {
  readonly productId: string;
  readonly yieldQuantity: Quantity;
  readonly lines: readonly RecipeLine[];
};

export function validateRecipeDraft(draft: RecipeDraft): void {
  assertPieces(draft.yieldQuantity, "1 バッチで焼ける個数");

  if (draft.lines.length === 0) {
    throw new ProductionValidationError("レシピには原材料が 1 つ以上必要です");
  }

  const seen = new Set<string>();
  for (const line of draft.lines) {
    if (seen.has(line.ingredientId)) {
      throw new ProductionValidationError(
        `同じ原材料が 2 行あります: ${line.ingredientId}。1 行にまとめてください`,
      );
    }
    seen.add(line.ingredientId);
    assertIngredientAmount(line.quantity, `原材料 ${line.ingredientId} の分量`);
  }
}

/**
 * 焼いた個数に必要なバッチ数。**切り上げる。**
 *
 * 理由: 生地はバッチ単位でしか仕込めない。20 個取りのレシピで 24 個焼いたなら、
 * ミキサーは 2 回回っていて、原材料は 2 バッチ分減っている。ここを比例配分
 * (1.2 倍) にすると帳簿上の消費が実際より少なくなり、inventory の在庫が
 * 実棚より多い方向にずれ続ける。在庫のずれは棚卸で補正する前提とはいえ、
 * 同じ向きに積み上がるずれは補正では追いつかない。
 *
 * この丸めの帰結として、製造計画はバッチの倍数で立てるのが望ましい。
 * 20 個取りのレシピで 24 個計画すると、16 個分の生地が余ることになる。
 */
export function requiredBatches(recipe: Recipe, producedQuantity: Quantity): number {
  assertPieces(producedQuantity, "焼き上がった個数");
  if (producedQuantity.unit !== recipe.yieldQuantity.unit) {
    throw new ProductionValidationError("焼き上がった個数とレシピの単位が違います");
  }
  return Math.ceil(producedQuantity.amount / recipe.yieldQuantity.amount);
}

/**
 * 消費した原材料。レシピ × バッチ数を**ここで**計算する。
 *
 * レシピは production の持ち物なので、inventory にレシピを引かせると境界を越える。
 * 計算を発行側で終わらせて、結果だけをイベント (consumedIngredients) に載せる。
 */
export function consumptionFor(recipe: Recipe, producedQuantity: Quantity): readonly RecipeLine[] {
  const batches = requiredBatches(recipe, producedQuantity);
  return recipe.lines.map((line) => ({
    ingredientId: line.ingredientId,
    quantity: scaleQuantity(line.quantity, batches),
  }));
}
