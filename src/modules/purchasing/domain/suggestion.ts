/**
 * 発注提案のドメイン。
 *
 * inventory から「発注点を割った」と言われても、**自動では発注しない**。
 * 仕入先ごとにリードタイムと最小ロットが違い、「明日の朝に要るのか来週でいいのか」
 * 「1袋 25kg 単位でしか買えないのか」は在庫数だけでは決まらない。
 * だから purchasing が作るのは提案までで、確定は人の判断に残す。
 */
import type { Quantity } from "../../../shared/events.ts";
import { conflict } from "./errors.ts";
import type { IngredientId, PurchaseOrderId } from "./purchase-order.ts";

/**
 * 提案の状態。
 *
 *   open     — 未対応。人がまだ判断していない
 *   ordered  — 発注済み。この提案から発注が起きた
 *   rejected — 却下。「まだ在庫がある」「次の便でまとめる」等
 */
export type SuggestionStatus = "open" | "ordered" | "rejected";

export type PurchaseSuggestion = {
  readonly suggestionId: string;
  readonly ingredientId: IngredientId;
  readonly suggestedQuantity: Quantity;
  /** 発注点を割ったと検知した時点の在庫。後から見て判断の妥当性を追えるように残す。 */
  readonly onHandAtDetection: Quantity;
  readonly status: SuggestionStatus;
  readonly createdAt: string;
  /** ordered になったときの発注 ID。 */
  readonly purchaseOrderId: PurchaseOrderId | null;
};

export function isOpen(suggestion: PurchaseSuggestion): boolean {
  return suggestion.status === "open";
}

/**
 * 未対応の提案だけが次の状態に進める。
 * 一度発注した提案をもう一度発注済みにしたり、却下した提案を後から発注済みに
 * したりすると、提案と発注の対応が追えなくなる。
 */
function assertOpen(suggestion: PurchaseSuggestion, action: string): void {
  if (suggestion.status !== "open") {
    throw conflict(
      `提案 ${suggestion.suggestionId} は既に ${suggestion.status} です。${action}できるのは open のときだけです`,
    );
  }
}

export function markOrdered(
  suggestion: PurchaseSuggestion,
  purchaseOrderId: PurchaseOrderId,
): PurchaseSuggestion {
  assertOpen(suggestion, "発注済みに");
  return { ...suggestion, status: "ordered", purchaseOrderId };
}

export function markRejected(suggestion: PurchaseSuggestion): PurchaseSuggestion {
  assertOpen(suggestion, "却下");
  return { ...suggestion, status: "rejected", purchaseOrderId: null };
}

/**
 * 同じ原材料に未対応の提案が既にあるか。
 *
 * イベントは at-least-once なので同じ発注点割れが2回届きうるし、業務的にも
 * 在庫が発注点付近を行き来すれば何度でも飛んでくる。未対応の提案が並ぶと
 * 人が見る一覧が使い物にならないので、1原材料につき未対応は1件までにする。
 *
 * 実際の重複防止は DB の部分ユニークインデックス
 * (`purchase_suggestions_open_ingredient_idx`) で担保する。競合したときに
 * 後勝ちで壊れないよう、判定をアプリ側だけに置かないため。
 */
export function hasOpenSuggestionFor(
  suggestions: readonly PurchaseSuggestion[],
  ingredientId: IngredientId,
): boolean {
  return suggestions.some(
    (suggestion) => suggestion.ingredientId === ingredientId && isOpen(suggestion),
  );
}
