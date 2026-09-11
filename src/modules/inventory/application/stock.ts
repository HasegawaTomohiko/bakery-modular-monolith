/**
 * 在庫を動かす共通処理。公開ユースケースと購読ハンドラの両方から使う。
 *
 * 原材料の在庫は2階建てになっている。
 *
 *   ingredients.on_hand  — 帳簿在庫。**唯一の正**で、マイナスになり得る
 *   ingredient_lots      — 実際に入ってきたモノの内訳。トレーサビリティと FEFO 用
 *
 * 不変条件: `sum(lots.remaining) <= max(on_hand, 0)`。
 * 入荷していないものを消費すれば帳簿だけがマイナスに振れ、ロット側は 0 で止まる
 * (入ってきていないモノを「使った」ことにはできないため)。この差が
 * 「ロットで裏付けられない不足」で、後から入荷が届いたときに真っ先に相殺される。
 * 棚卸で帳簿が実地より増える場合も、どのロットの粉かは分からないのでロットには載せない。
 */
import type { Quantity } from "../../../shared/events.ts";
import { evaluateReorderPoint, type Ingredient } from "../domain/ingredient.ts";
import { allocateFefo } from "../domain/ingredient-lot.ts";
import { add, coerceUnit, quantityOf, roundAmount } from "../domain/quantity.ts";
import type { UnitOfWork } from "./ports.ts";

/**
 * 帳簿在庫を `delta` だけ動かし、ロット側を辻褄の合う範囲で追従させ、
 * 発注点割れを評価する。戻り値は変更後の原材料。
 *
 * `detectedAt` は発注点割れイベントに載せる時刻。イベント由来なら発生時刻、
 * 人の操作由来なら現在時刻を渡す。
 */
export async function applyIngredientDelta(
  uow: UnitOfWork,
  ingredient: Ingredient,
  delta: Quantity,
  detectedAt: Date,
): Promise<Ingredient> {
  // 単位は自スキーマの登録値を正とする (イベントの単位がずれていても止めない)。
  const normalized = coerceUnit(delta, ingredient.unit);
  const before = ingredient.onHand;
  const after = add(before, normalized);

  // ロット側をどれだけ引き当てるか。
  // 減るときはその分だけ。増えるときは「裏付けの無い不足」を先に相殺する分だけ。
  const shortfallBefore = Math.max(-roundAmount(before.amount), 0);
  const toDrain =
    normalized.amount < 0 ? -normalized.amount : Math.min(normalized.amount, shortfallBefore);
  if (toDrain > 0) {
    await drainLots(uow, ingredient.ingredientId, quantityOf(toDrain, ingredient.unit));
  }

  const updated: Ingredient = { ...ingredient, onHand: after };
  const evaluation = evaluateReorderPoint(updated);
  await uow.repo.updateIngredientStock(ingredient.ingredientId, after, evaluation.belowNow);

  // 「上回る → 下回る」に変わった瞬間だけ発行する。下回っている間ずっと出すと、
  // 消費のたびに提案が飛んで purchasing 側の一覧が使い物にならない。
  if (evaluation.breached) {
    await uow.publish("inventory.ReorderPointBreached", {
      ingredientId: ingredient.ingredientId,
      onHand: after,
      reorderPoint: ingredient.reorderPoint,
      suggestedOrderQuantity: evaluation.suggestedOrderQuantity,
      detectedAt: detectedAt.toISOString(),
    });
  }

  return { ...updated, belowReorderPoint: evaluation.belowNow };
}

/**
 * FEFO (賞味期限の早い順) でロットから引き当てる。引き当てきれない分は捨てる
 * (帳簿在庫側が既にマイナスを引き受けているので、ここで例外にする必要はない)。
 */
async function drainLots(
  uow: UnitOfWork,
  ingredientId: string,
  demand: Quantity,
): Promise<Quantity> {
  const lots = await uow.repo.listOpenLots(ingredientId);
  const result = allocateFefo(lots, demand);
  for (const allocation of result.allocations) {
    await uow.repo.updateLotRemaining(allocation.lotId, allocation.remaining);
  }
  return result.shortfall;
}
