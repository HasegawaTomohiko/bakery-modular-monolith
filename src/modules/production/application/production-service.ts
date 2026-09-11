/**
 * production のユースケース。ここがトランザクション境界。
 *
 * イベントの発行 (outbox への書き込み) は必ず業務データと同じトランザクションで行う。
 * 「焼き上がりは記録されたのに inventory へ通知が出ていない」を起こさないため。
 *
 * 依存は ports.ts の口だけを見る。DB も HTTP も知らないので、判断そのものを
 * 単体テストで固定できる (production-service.test.ts)。
 */
import type { EventEnvelope, Quantity } from "../../../shared/events.ts";
import type { Executor } from "../../../shared/tables.ts";
import {
  assertBusinessDate,
  type BusinessDate,
  businessDateOf,
  shiftBusinessDate,
} from "../domain/business-date.ts";
import {
  type DemandForecast,
  FORECAST_WINDOW_DAYS,
  forecastDemand,
} from "../domain/demand-forecast.ts";
import { ProductionNotFoundError, ProductionValidationError } from "../domain/errors.ts";
import {
  type ProductionPlan,
  type ProductionPlanItem,
  validatePlanItems,
  withoutProducts,
} from "../domain/production-plan.ts";
import type { ProductionRun } from "../domain/production-run.ts";
import { assertPieces } from "../domain/quantity.ts";
import {
  consumptionFor,
  type Recipe,
  type RecipeDraft,
  validateRecipeDraft,
} from "../domain/recipe.ts";
import type { ProductionDeps } from "./ports.ts";

export type CompleteProductionRunInput = {
  readonly productionPlanId: string;
  readonly productId: string;
  readonly recipeId: string;
  readonly producedQuantity: Quantity;
  readonly lotCode: string;
  readonly bestBefore: string;
  readonly completedAt: string;
};

export type PlanProductionInput = {
  readonly businessDate: string;
  readonly items: readonly ProductionPlanItem[];
};

/** 計画に無い商品を焼いたときの計画数。0 個。実績との差がそのまま「計画外」を表す。 */
const UNPLANNED = { amount: 0, unit: "piece" } as const;

export function createProductionService(deps: ProductionDeps) {
  /** レシピの版を 1 つ作る。既存の版は書き換えない (過去の実績から辿れなくなるため)。 */
  async function registerRecipe(draft: RecipeDraft): Promise<string> {
    validateRecipeDraft(draft);

    return deps.runInTransaction(async (tx) => {
      const version = await deps.recipes.nextVersion(tx, draft.productId);
      const recipe: Recipe = {
        recipeId: deps.newId(),
        productId: draft.productId,
        version,
        yieldQuantity: draft.yieldQuantity,
        lines: draft.lines,
        registeredAt: deps.now(),
      };
      await deps.recipes.insert(tx, recipe);
      return recipe.recipeId;
    });
  }

  async function getRecipe(recipeId: string): Promise<Recipe | null> {
    return deps.runInTransaction((tx) => deps.recipes.findById(tx, recipeId));
  }

  /**
   * コアドメイン: 今日何を何個焼くかを決める。
   *
   * 同じ営業日に何度も立て直せる。朝の仕込み中に予約が入る、雨で客足が鈍る、
   * といった理由で計画が変わるのは日常なので、既存の計画は置き換える。
   * 計画そのものは basis 付きで残るため、「なぜその数にしたか」は失われない。
   */
  async function planProduction(input: PlanProductionInput): Promise<string> {
    const businessDate = assertBusinessDate(input.businessDate);
    validatePlanItems(input.items);

    return deps.runInTransaction(async (tx) => {
      for (const item of input.items) {
        const recipe = await deps.recipes.findById(tx, item.recipeId);
        if (recipe === null) {
          throw new ProductionNotFoundError(`レシピが見つかりません: ${item.recipeId}`);
        }
        if (recipe.productId !== item.productId) {
          throw new ProductionValidationError(
            `レシピ ${item.recipeId} は別の商品 (${recipe.productId}) のものです`,
          );
        }
      }

      // 販売停止になった商品は計画から外す。エラーにしないのは、計画が日次で
      // 自動生成される想定で、停止品が紛れ込むのは異常ではないため。
      // ここで落とすと停止品 1 つのせいでその日の計画全体が立たなくなる。
      const delisted = await deps.delistedProducts.filterDelisted(
        tx,
        input.items.map((item) => item.productId),
      );
      const items = withoutProducts(input.items, delisted);

      const existing = await deps.plans.findByBusinessDate(tx, businessDate);
      const plan: ProductionPlan = {
        productionPlanId: existing?.productionPlanId ?? deps.newId(),
        businessDate,
        items,
      };
      await deps.plans.save(tx, plan);
      return plan.productionPlanId;
    });
  }

  async function getProductionPlan(businessDate: string): Promise<ProductionPlan | null> {
    const date = assertBusinessDate(businessDate);
    return deps.runInTransaction((tx) => deps.plans.findByBusinessDate(tx, date));
  }

  /**
   * 焼き上がりを記録し、`production.ProductionCompleted` を発行する。
   *
   * 消費した原材料は「レシピ × バッチ数」でここで算出してイベントに載せる。
   * レシピは production の持ち物なので、inventory に引かせると境界を越える。
   */
  async function completeProductionRun(input: CompleteProductionRunInput): Promise<string> {
    assertPieces(input.producedQuantity, "焼き上がった個数");
    const bestBefore = assertBusinessDate(input.bestBefore, "賞味期限");
    if (input.lotCode.trim() === "") {
      throw new ProductionValidationError("ロット番号は必須です");
    }

    return deps.runInTransaction(async (tx) => {
      const recipe = await deps.recipes.findById(tx, input.recipeId);
      if (recipe === null) {
        throw new ProductionNotFoundError(`レシピが見つかりません: ${input.recipeId}`);
      }
      if (recipe.productId !== input.productId) {
        throw new ProductionValidationError(
          `レシピ ${input.recipeId} は別の商品 (${recipe.productId}) のものです`,
        );
      }

      const plan = await deps.plans.findById(tx, input.productionPlanId);
      if (plan === null) {
        throw new ProductionNotFoundError(`製造計画が見つかりません: ${input.productionPlanId}`);
      }
      const plannedItem = plan.items.find((item) => item.productId === input.productId);

      const consumed = consumptionFor(recipe, input.producedQuantity);

      const run: ProductionRun = {
        productionRunId: deps.newId(),
        productionPlanId: plan.productionPlanId,
        productId: input.productId,
        recipeId: recipe.recipeId,
        // 計画数と実績数の両方を残す。差分が改善の入力になる。
        plannedQuantity: plannedItem?.plannedQuantity ?? UNPLANNED,
        producedQuantity: input.producedQuantity,
        lotCode: input.lotCode,
        bestBefore,
        completedAt: input.completedAt,
        consumedIngredients: consumed,
      };
      await deps.runs.insert(tx, run);

      await deps.publishProductionCompleted(tx, {
        productionRunId: run.productionRunId,
        productionPlanId: run.productionPlanId,
        productId: run.productId,
        recipeId: run.recipeId,
        producedQuantity: run.producedQuantity,
        lotCode: run.lotCode,
        bestBefore: run.bestBefore,
        completedAt: run.completedAt,
        consumedIngredients: consumed.map((line) => ({
          ingredientId: line.ingredientId,
          quantity: line.quantity,
        })),
      });

      return run.productionRunId;
    });
  }

  /** 販売実績から需要を見積もる。根拠 (basis) を必ず添える。 */
  async function getDemandForecast(
    productId: string,
    businessDate: string,
  ): Promise<DemandForecast> {
    const date = assertBusinessDate(businessDate);
    const from = shiftBusinessDate(date, -FORECAST_WINDOW_DAYS);
    const to = shiftBusinessDate(date, -1);

    return deps.runInTransaction(async (tx) => {
      const samples = await deps.salesResults.listDailySales(tx, productId, from, to);
      const reserved = await deps.salesResults.reservedQuantity(tx, productId, date);
      return forecastDemand({
        productId,
        businessDate: date,
        samples,
        reservedQuantity: reserved,
      });
    });
  }

  // -------------------------------------------------------------------------
  // 購読 (worker から、購読側 = production のロールの tx で呼ばれる)
  // -------------------------------------------------------------------------

  /**
   * sales.SaleCompleted: 需要予測の入力として販売実績を記録する。
   *
   * 営業日は soldAt の現地日付を使う (domain/business-date.ts 参照)。
   */
  async function recordSalesResult(
    event: EventEnvelope<"sales.SaleCompleted">,
    tx: Executor,
  ): Promise<void> {
    const businessDate: BusinessDate = businessDateOf(event.payload.soldAt);

    for (const line of event.payload.lines) {
      // 製品は個数で数える。個数以外が来たら契約側の不整合なので、
      // ここで例外にすると relay が止まり続ける。予測の標本を 1 行落とす方が
      // 影響が小さいので、記録せずに警告だけ出す。
      if (line.quantity.unit !== "piece") {
        console.warn(
          `production: 個数以外の販売行を無視しました (event=${event.id}, unit=${line.quantity.unit})`,
        );
        continue;
      }
      await deps.salesResults.add(tx, {
        businessDate,
        productId: line.productId,
        channel: event.payload.channel,
        soldQuantity: line.quantity.amount,
      });
    }
  }

  /**
   * catalog.ProductDelisted: 以降の計画からその商品を外す。
   *
   * 過去の計画は消さない。「なぜその日それを焼いたか」の記録であり、
   * 後から書き換えると製造実績の説明が付かなくなるため。
   */
  async function dropDelistedProductFromPlan(
    event: EventEnvelope<"catalog.ProductDelisted">,
    tx: Executor,
  ): Promise<void> {
    await deps.delistedProducts.markDelisted(tx, {
      productId: event.payload.productId,
      delistedAt: event.payload.delistedAt,
      reason: event.payload.reason,
    });
    await deps.plans.removeProductFrom(
      tx,
      event.payload.productId,
      businessDateOf(event.payload.delistedAt),
    );
  }

  return {
    registerRecipe,
    getRecipe,
    planProduction,
    getProductionPlan,
    completeProductionRun,
    getDemandForecast,
    recordSalesResult,
    dropDelistedProductFromPlan,
  } as const;
}

export type ProductionService = ReturnType<typeof createProductionService>;
