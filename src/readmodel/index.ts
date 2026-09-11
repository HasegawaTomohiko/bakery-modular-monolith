/**
 * 参照モデル (readmodel) の公開面。
 *
 * **これはモジュール (境界づけられたコンテキスト) ではない。**
 * 業務ロジックも不変条件も持たず、イベントを購読して投影し、画面向けに読ませるだけ。
 * したがって outbox を持たず、何も発行しない。
 *
 * なぜ要るのか: コンテキストをまたぐ画面 (今日の在庫と販売状況) は JOIN では
 * 作れない。モジュールのスキーマには USAGE すら無く、そこを緩めるのは境界を壊すこと。
 * 「画面のために境界を緩める」代わりに「画面のための投影を別に持つ」という選択。
 *
 * 依存の向きは readmodel → shared の一方向だけ。モジュールを import してはいけない
 * (dependency-cruiser の no-readmodel-to-module が落とす)。依存した瞬間、そこが
 * JOIN の代わりになって同じ問題が戻ってくる。
 */
export { readmodelSubscriptions } from "./projections.ts";
export {
  type DailyDashboard,
  type DailyIngredientRow,
  type DailyLotRow,
  type DailyProductRow,
  type DailyTotals,
  getDailyDashboard,
  getDailyIngredientFlow,
} from "./queries.ts";
