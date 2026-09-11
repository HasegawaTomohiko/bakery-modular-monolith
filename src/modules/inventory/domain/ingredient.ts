/**
 * 原材料在庫のドメイン。
 *
 * **製品在庫 (product-lot.ts) とは別のモデル。** 原材料は g / ml で数え、
 * 日〜週単位の賞味期限を持ち、期限切れで廃棄が出て、発注点を持つ。
 * 製品は個数で数え、当日限りで、売れ残りが毎日廃棄になり、発注点は無い
 * (何個焼くかは production の製造計画が決める)。1つの表に押し込まない。
 */
import type { Quantity } from "../../../shared/events.ts";
import type { Unit } from "./quantity.ts";
import { isLessThan, quantityOf, subtract } from "./quantity.ts";

export type IngredientId = string;

/** 原材料1件の在庫。`onHand` は帳簿上の数で、マイナスになり得る。 */
export type Ingredient = {
  readonly ingredientId: IngredientId;
  readonly name: string;
  readonly unit: Unit;
  readonly onHand: Quantity;
  readonly reorderPoint: Quantity;
  /**
   * 直前の評価で発注点を下回っていたか。
   *
   * 発注点割れイベントを「下回っている間ずっと」出さないための状態。
   * 上回る → 下回る に変わった瞬間だけ発行する (エッジトリガ)。
   */
  readonly belowReorderPoint: boolean;
};

/**
 * 発注点を割ったときに「いくつ頼めばよいか」の目安。
 *
 * 発注点はリードタイム中に消費する量として置かれるので、発注点ちょうどまで
 * 戻すと届いた翌日にまた割れる。ひと回転分の余裕を見て発注点の2倍を目標にし、
 * 現在庫との差を提案する。在庫がマイナスなら不足分も込みで多めに出る。
 *
 * これは**提案**であって発注ではない。仕入先のリードタイムと最小ロットを見て
 * 確定させるのは purchasing 側 (と人) の仕事。
 */
export function suggestOrderQuantity(onHand: Quantity, reorderPoint: Quantity): Quantity {
  const target = quantityOf(reorderPoint.amount * 2, reorderPoint.unit);
  const shortage = subtract(target, { amount: onHand.amount, unit: reorderPoint.unit });
  // 発注点が 0 の原材料 (実質「発注点なし」) でも 0 個の提案は無意味なので下限を置く。
  const amount = Math.max(shortage.amount, reorderPoint.amount, 1);
  return quantityOf(amount, reorderPoint.unit);
}

export type ReorderEvaluation = {
  /** 評価後に発注点を下回っているか。DB の belowReorderPoint に書き戻す。 */
  readonly belowNow: boolean;
  /** 今回「上回る → 下回る」に変わったか。true のときだけイベントを発行する。 */
  readonly breached: boolean;
  readonly suggestedOrderQuantity: Quantity;
};

/**
 * 発注点割れを評価する。
 *
 * 在庫が変わる操作 (入庫・消費・出庫・棚卸) の後に必ず呼び、`breached` のときだけ
 * `inventory.ReorderPointBreached` を発行する。下回っている間ずっと発行すると、
 * 消費のたびに提案が飛んで一覧が使い物にならなくなる。
 * 入庫で発注点を上回ったら `belowNow` が false に戻り、次に割ったときまた発行できる。
 */
export function evaluateReorderPoint(ingredient: Ingredient): ReorderEvaluation {
  const belowNow = isLessThan(ingredient.onHand, {
    amount: ingredient.reorderPoint.amount,
    unit: ingredient.onHand.unit,
  });
  return {
    belowNow,
    breached: belowNow && !ingredient.belowReorderPoint,
    suggestedOrderQuantity: suggestOrderQuantity(ingredient.onHand, ingredient.reorderPoint),
  };
}
