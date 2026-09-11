/**
 * ユースケースが必要とする外の世界の口。
 *
 * 実体は infra が drizzle で実装する。ここで口として切っておく理由は 2 つ。
 * 1. ユースケース (製造計画の判断そのもの) を DB 無しで単体テストできるようにする
 * 2. domain と application が SQL を知らない状態を保つ
 *
 * すべての操作が `tx` を受け取るのは、業務データの書き込みと outbox への書き込みを
 * **同じトランザクション**に収めるため (境界の強制 3/3)。
 */
import type { EventPayload } from "../../../shared/events.ts";
import type { Executor } from "../../../shared/tables.ts";
import type { BusinessDate } from "../domain/business-date.ts";
import type { SalesSample } from "../domain/demand-forecast.ts";
import type { ProductionPlan, ProductionPlanItem } from "../domain/production-plan.ts";
import type { ProductionRun } from "../domain/production-run.ts";
import type { Recipe } from "../domain/recipe.ts";

export type TransactionRunner = <T>(run: (tx: Executor) => Promise<T>) => Promise<T>;

export type RecipeRepository = {
  /** 同じ商品の次の版番号。レシピは更新せず版を重ねる。 */
  nextVersion(tx: Executor, productId: string): Promise<number>;
  insert(tx: Executor, recipe: Recipe): Promise<void>;
  findById(tx: Executor, recipeId: string): Promise<Recipe | null>;
};

export type ProductionPlanRepository = {
  findById(tx: Executor, productionPlanId: string): Promise<ProductionPlan | null>;
  findByBusinessDate(tx: Executor, businessDate: BusinessDate): Promise<ProductionPlan | null>;
  /** 営業日の計画を丸ごと置き換える。朝の立て直しが日常なので更新ではなく置換。 */
  save(tx: Executor, plan: ProductionPlan): Promise<void>;
  /** 指定営業日以降の計画からその商品を外す。販売停止の購読で使う。 */
  removeProductFrom(
    tx: Executor,
    productId: string,
    fromBusinessDate: BusinessDate,
  ): Promise<number>;
};

export type ProductionRunRepository = {
  insert(tx: Executor, run: ProductionRun): Promise<void>;
};

export type SalesResultEntry = {
  readonly businessDate: BusinessDate;
  readonly productId: string;
  readonly channel: "storefront" | "reservation";
  readonly soldQuantity: number;
};

export type SalesResultRepository = {
  /** 販売実績を積み上げる。同じ (営業日, 商品, チャネル) は加算する。 */
  add(tx: Executor, entry: SalesResultEntry): Promise<void>;
  /** 予測の標本。チャネルをまとめた営業日ごとの販売数。 */
  listDailySales(
    tx: Executor,
    productId: string,
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<readonly SalesSample[]>;
  /** その営業日に予約チャネルで確定している数量。 */
  reservedQuantity(tx: Executor, productId: string, businessDate: BusinessDate): Promise<number>;
};

export type DelistedProduct = {
  readonly productId: string;
  readonly delistedAt: string;
  readonly reason: string;
};

export type DelistedProductRepository = {
  markDelisted(tx: Executor, product: DelistedProduct): Promise<void>;
  /** 渡した商品のうち販売停止になっているもの。計画から外すために引く。 */
  filterDelisted(tx: Executor, productIds: readonly string[]): Promise<ReadonlySet<string>>;
};

export type ProductionDeps = {
  readonly runInTransaction: TransactionRunner;
  /**
   * 製造完了イベントを outbox に積む。**業務データと同じ tx** で呼ぶこと。
   * 型を 1 イベントに絞ってあるのは、production が発行できるのがこれだけだから。
   */
  readonly publishProductionCompleted: (
    tx: Executor,
    payload: EventPayload<"production.ProductionCompleted">,
  ) => Promise<void>;
  readonly recipes: RecipeRepository;
  readonly plans: ProductionPlanRepository;
  readonly runs: ProductionRunRepository;
  readonly salesResults: SalesResultRepository;
  readonly delistedProducts: DelistedProductRepository;
  /** ID の採番と現在時刻。単体テストで固定できるように外から渡す。 */
  readonly newId: () => string;
  readonly now: () => Date;
};

export type { ProductionPlanItem };
