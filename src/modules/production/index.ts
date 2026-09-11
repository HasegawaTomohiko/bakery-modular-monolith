/**
 * production モジュールの公開 API (**コアドメイン**)。
 *
 * 責務: 製造計画、レシピ、製造実績
 *
 * パン屋は当日焼いて当日売り切る見込み生産で、製品の寿命は基本1日。
 * 売上と廃棄ロスを分けるのは「今日何を何個焼くか」という製造計画であり、
 * このモジュールがそれを持つ。ここが一番作り込む場所。
 *
 * ここでの「クロワッサン」は**原材料と分量を持つレシピ**であり、
 * catalog の販売物とも inventory のロットとも別のもの。
 *
 * 公開シグネチャは Phase 4a で確定した契約。実装 (Phase 4b) で変えないこと。
 */
import { defineSubscription, type Subscription } from "../../shared/event-bus.ts";
import type { Quantity } from "../../shared/events.ts";
import { productionService } from "./infra/module.ts";

// ---------------------------------------------------------------------------
// 公開型
// ---------------------------------------------------------------------------

export type RecipeId = string;
export type ProductionPlanId = string;
export type ProductionRunId = string;
/** catalog の商品識別子。名前や価格は catalog に同期で問い合わせる。 */
export type ProductId = string;
/** inventory の原材料識別子。在庫数は inventory に問い合わせる。 */
export type IngredientId = string;

export type RecipeLine = {
  readonly ingredientId: IngredientId;
  /** 1バッチあたりの分量。 */
  readonly quantity: Quantity;
};

export type RecipeView = {
  readonly recipeId: RecipeId;
  readonly productId: ProductId;
  /** 1バッチで焼ける個数。 */
  readonly yieldQuantity: Quantity;
  readonly lines: readonly RecipeLine[];
};

export type ProductionPlanItem = {
  readonly productId: ProductId;
  readonly recipeId: RecipeId;
  readonly plannedQuantity: Quantity;
  /** その数にした根拠。計画の良し悪しを後から検証するために残す。 */
  readonly basis: "forecast" | "reservation" | "manual";
};

export type ProductionPlanView = {
  readonly productionPlanId: ProductionPlanId;
  readonly businessDate: string;
  readonly items: readonly ProductionPlanItem[];
};

/**
 * 需要予測。売上と廃棄ロスの分かれ目なので、根拠を必ず添える。
 * 入力は sales.SaleCompleted から蓄えた販売実績。
 */
export type DemandForecast = {
  readonly productId: ProductId;
  readonly businessDate: string;
  readonly forecastQuantity: Quantity;
  readonly basis: {
    readonly sampleDays: number;
    readonly averageSoldQuantity: Quantity;
    readonly reservedQuantity: Quantity;
  };
};

export type RegisterRecipeInput = {
  readonly productId: ProductId;
  readonly yieldQuantity: Quantity;
  readonly lines: readonly RecipeLine[];
};

export type PlanProductionInput = {
  readonly businessDate: string;
  readonly items: readonly ProductionPlanItem[];
};

/** 焼き上がり。`production.ProductionCompleted` を発行する。 */
export type CompleteProductionRunInput = {
  readonly productionPlanId: ProductionPlanId;
  readonly productId: ProductId;
  readonly recipeId: RecipeId;
  readonly producedQuantity: Quantity;
  readonly lotCode: string;
  readonly bestBefore: string;
  readonly completedAt: string;
};

// ---------------------------------------------------------------------------
// 公開ユースケース
// ---------------------------------------------------------------------------

/**
 * 本体は application/production-service.ts にある。ここは公開面に徹する。
 *
 * 戻り値の型を狭めているのは意図的で、実装の Recipe は版番号や登録時刻も持つが、
 * 公開する RecipeView には出さない。公開面を広げると、他モジュールが
 * production の内部モデルに依存し始めるため。
 */
export const production = {
  registerRecipe(input: RegisterRecipeInput): Promise<RecipeId> {
    return productionService().registerRecipe(input);
  },

  getRecipe(recipeId: RecipeId): Promise<RecipeView | null> {
    return productionService().getRecipe(recipeId);
  },

  /** コアドメイン: 今日何を何個焼くかを決める。 */
  planProduction(input: PlanProductionInput): Promise<ProductionPlanId> {
    return productionService().planProduction(input);
  },

  getProductionPlan(businessDate: string): Promise<ProductionPlanView | null> {
    return productionService().getProductionPlan(businessDate);
  },

  /**
   * 製造完了を記録する。`production.ProductionCompleted` を発行する。
   * 消費する原材料はレシピ×数量からここで算出してイベントに載せる。
   * inventory にレシピを引かせない (境界を越えるため)。
   */
  completeProductionRun(input: CompleteProductionRunInput): Promise<ProductionRunId> {
    return productionService().completeProductionRun(input);
  },

  /** 販売実績から需要を見積もる。計画の入力。 */
  getDemandForecast(productId: ProductId, businessDate: string): Promise<DemandForecast> {
    return productionService().getDemandForecast(productId, businessDate);
  },
} as const;

// ---------------------------------------------------------------------------
// 購読
// ---------------------------------------------------------------------------

export const productionSubscriptions: readonly Subscription[] = [
  defineSubscription({
    subscriber: "production",
    handler: "record-sales-result",
    eventName: "sales.SaleCompleted",
    // 需要予測の入力として販売実績を記録する。
    // tx は購読側 (production) のロールの接続。inbox への記録と同じ tx なので、
    // ここで書いた実績は「処理済み」の記録と一緒にしか確定しない。
    handle: (event, tx) => productionService().recordSalesResult(event, tx),
  }),
  defineSubscription({
    subscriber: "production",
    handler: "drop-delisted-product-from-plan",
    eventName: "catalog.ProductDelisted",
    // 参照している商品情報を更新し、以降の計画から外す。
    handle: (event, tx) => productionService().dropDelistedProductFromPlan(event, tx),
  }),
];
