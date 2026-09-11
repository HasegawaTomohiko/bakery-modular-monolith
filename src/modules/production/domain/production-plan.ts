/**
 * 製造計画。**コアドメイン**。
 *
 * 「今日何を何個焼くか」がパン屋の売上と廃棄ロスを分ける。焼きすぎれば
 * 当日限りの製品が廃棄になり、足りなければ売り逃す。だからこの判断そのものを
 * モデルとして残す。
 *
 * 数量だけでなく **basis (なぜその数にしたか)** を必ず持たせるのは、後から
 * 計画の良し悪しを検証するため。「予測で 30 個としたが 12 個しか売れなかった」と
 * 「予約が 30 個あったので 30 個焼いた」は、同じ 30 でも意味も反省の仕方も違う。
 */
import type { Quantity } from "../../../shared/events.ts";
import type { BusinessDate } from "./business-date.ts";
import { ProductionValidationError } from "./errors.ts";
import { assertPieces } from "./quantity.ts";

/**
 * その数にした根拠。
 * - forecast    : 需要予測から (getDemandForecast の結果を使った)
 * - reservation : 予約が入っているから (作らないと引き渡せない)
 * - manual      : 人の判断で (イベント出店、天気、新商品の様子見など)
 */
export type PlanBasis = "forecast" | "reservation" | "manual";

const PLAN_BASES: readonly PlanBasis[] = ["forecast", "reservation", "manual"];

export type ProductionPlanItem = {
  readonly productId: string;
  /** どの版のレシピで焼くか。配合を変えた日を跨いでも計画を再現できる。 */
  readonly recipeId: string;
  readonly plannedQuantity: Quantity;
  readonly basis: PlanBasis;
};

export type ProductionPlan = {
  readonly productionPlanId: string;
  readonly businessDate: BusinessDate;
  readonly items: readonly ProductionPlanItem[];
};

export function isPlanBasis(value: string): value is PlanBasis {
  return (PLAN_BASES as readonly string[]).includes(value);
}

export function validatePlanItems(items: readonly ProductionPlanItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.productId)) {
      throw new ProductionValidationError(
        `同じ商品が 2 行あります: ${item.productId}。1 行にまとめてください`,
      );
    }
    seen.add(item.productId);
    assertPieces(item.plannedQuantity, `商品 ${item.productId} の計画数`);
    if (!isPlanBasis(item.basis)) {
      throw new ProductionValidationError(`計画の根拠が不正です: ${item.basis}`);
    }
  }
}

/** 販売停止になった商品を計画から外す。catalog.ProductDelisted の購読で使う。 */
export function withoutProducts(
  items: readonly ProductionPlanItem[],
  productIds: ReadonlySet<string>,
): readonly ProductionPlanItem[] {
  return items.filter((item) => !productIds.has(item.productId));
}
