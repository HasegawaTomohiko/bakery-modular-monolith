/**
 * 製造実績。
 *
 * 計画数と実績数の**両方**を残す。差分こそが改善の入力だから。
 * 「30 個計画して 24 個しか焼けなかった」は生地の失敗か時間切れかもしれないし、
 * 「30 個計画して 40 個焼いた」はバッチの丸め (recipe.ts 参照) かもしれない。
 * 実績だけを残すと、この違いが翌日には分からなくなる。
 *
 * 消費した原材料も実績として持つ。イベントに載せて inventory へ渡す値と
 * 同じものを自分でも持っておかないと、後から原価と歩留まりを追えない。
 */
import type { Quantity } from "../../../shared/events.ts";
import type { BusinessDate } from "./business-date.ts";
import type { RecipeLine } from "./recipe.ts";

export type ProductionRun = {
  readonly productionRunId: string;
  readonly productionPlanId: string;
  readonly productId: string;
  /** 実際に使ったレシピの版。 */
  readonly recipeId: string;
  /** 計画数。計画に無い商品を焼いた場合は 0 個。 */
  readonly plannedQuantity: Quantity;
  readonly producedQuantity: Quantity;
  /** 製品ロット。当日焼いて当日売り切るので寿命は基本 1 日。 */
  readonly lotCode: string;
  readonly bestBefore: BusinessDate;
  readonly completedAt: string;
  readonly consumedIngredients: readonly RecipeLine[];
};

/** 実績 - 計画。正なら焼きすぎ、負なら足りていない。 */
export function quantityVariance(run: ProductionRun): number {
  return run.producedQuantity.amount - run.plannedQuantity.amount;
}
