/**
 * production スキーマ。テーブルは必ずこのスキーマに属させる。
 *
 * 責務: 製造計画、レシピ、製造実績
 *
 * 他モジュールのスキーマには USAGE すら無いので、ここから外部キーや JOIN を
 * 張ることはできない (境界の強制 2/3)。他文脈のものは識別子だけを持つ:
 * product_id は catalog の商品、ingredient_id は inventory の原材料を指すが、
 * 名前も価格も在庫数もここには持たない。
 *
 * outbox / inbox は全モジュール共通の形なので shared/tables.ts から生やす。
 */
import { sql } from "drizzle-orm";
import {
  date,
  index,
  integer,
  numeric,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { moduleBaseTables } from "../../../../shared/tables.ts";

const base = moduleBaseTables("production");

export const productionSchema = base.schema;
export const outbox = base.outbox;
export const inbox = base.inbox;

/** 数量。g / ml は mg まで、piece は整数。単位は基本単位のまま持つ。 */
const amount = (name: string) => numeric(name, { precision: 12, scale: 3, mode: "number" });

/**
 * レシピの版。
 *
 * 配合を変えたら行を書き換えず、新しい版 (= 新しい id) を作る。製造実績が
 * recipe_id を持つので、何年前の実績でも当時の配合に辿り着ける。
 */
export const recipes = productionSchema.table(
  "recipes",
  {
    id: uuid("id").primaryKey(),
    /** catalog の商品識別子。外部キーは張れない (張らないのではなく張れない)。 */
    productId: uuid("product_id").notNull(),
    version: integer("version").notNull(),
    /** 1 バッチで焼ける個数。 */
    yieldAmount: amount("yield_amount").notNull(),
    yieldUnit: text("yield_unit").notNull(),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("recipes_product_version_uq").on(table.productId, table.version),
    index("recipes_product_idx").on(table.productId),
  ],
);

export const recipeLines = productionSchema.table(
  "recipe_lines",
  {
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    /** inventory の原材料識別子。分量だけを持ち、在庫数は持たない。 */
    ingredientId: uuid("ingredient_id").notNull(),
    lineAmount: amount("line_amount").notNull(),
    lineUnit: text("line_unit").notNull(),
  },
  (table) => [primaryKey({ columns: [table.recipeId, table.ingredientId] })],
);

/** 営業日ごとの製造計画。1 営業日に 1 つ。立て直しは items の置き換えで表す。 */
export const productionPlans = productionSchema.table(
  "production_plans",
  {
    id: uuid("id").primaryKey(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("production_plans_business_date_uq").on(table.businessDate)],
);

export const productionPlanItems = productionSchema.table(
  "production_plan_items",
  {
    productionPlanId: uuid("production_plan_id")
      .notNull()
      .references(() => productionPlans.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull(),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipes.id),
    plannedAmount: amount("planned_amount").notNull(),
    plannedUnit: text("planned_unit").notNull(),
    /** なぜその数にしたか。forecast / reservation / manual。 */
    basis: text("basis").notNull(),
  },
  (table) => [primaryKey({ columns: [table.productionPlanId, table.productId] })],
);

/** 製造実績。計画数と実績数の両方を残す。差分が改善の入力になる。 */
export const productionRuns = productionSchema.table(
  "production_runs",
  {
    id: uuid("id").primaryKey(),
    productionPlanId: uuid("production_plan_id")
      .notNull()
      .references(() => productionPlans.id),
    productId: uuid("product_id").notNull(),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipes.id),
    plannedAmount: amount("planned_amount").notNull(),
    producedAmount: amount("produced_amount").notNull(),
    quantityUnit: text("quantity_unit").notNull(),
    /** 製品ロット。当日焼いて当日売り切るので寿命は基本 1 日。 */
    lotCode: text("lot_code").notNull(),
    bestBefore: date("best_before", { mode: "string" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("production_runs_product_idx").on(table.productId, table.completedAt)],
);

/**
 * 実績が消費した原材料。イベントに載せる値と同じものを自分でも残す。
 * 後から原価と歩留まりを追うために必要で、イベントは配信したら手元に残らないため。
 */
export const productionRunConsumptions = productionSchema.table(
  "production_run_consumptions",
  {
    productionRunId: uuid("production_run_id")
      .notNull()
      .references(() => productionRuns.id, { onDelete: "cascade" }),
    ingredientId: uuid("ingredient_id").notNull(),
    consumedAmount: amount("consumed_amount").notNull(),
    consumedUnit: text("consumed_unit").notNull(),
  },
  (table) => [primaryKey({ columns: [table.productionRunId, table.ingredientId] })],
);

/**
 * 販売実績。sales.SaleCompleted を購読して積み上げた、需要予測の入力。
 *
 * sales のテーブルを見に行くことはできないので、必要な分だけをこちらに持つ
 * (コンテキストをまたぐ画面を JOIN で作らず、イベントから組み立てるのと同じ考え方)。
 * チャネルを分けて持つのは、予約分が予測の下限として効くため。
 */
export const salesResults = productionSchema.table(
  "sales_results",
  {
    businessDate: date("business_date", { mode: "string" }).notNull(),
    productId: uuid("product_id").notNull(),
    channel: text("channel").notNull(),
    soldAmount: amount("sold_amount").notNull(),
    quantityUnit: text("quantity_unit").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.businessDate, table.productId, table.channel] }),
    index("sales_results_product_idx").on(table.productId, table.businessDate),
  ],
);

/**
 * 販売停止になった商品。catalog.ProductDelisted を購読して記録する。
 * 名前も理由の詳細も catalog の持ち物なので、識別子と停止時刻だけを持つ。
 */
export const delistedProducts = productionSchema.table("delisted_products", {
  productId: uuid("product_id").primaryKey(),
  delistedAt: timestamp("delisted_at", { withTimezone: true }).notNull(),
  reason: text("reason").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().default(sql`now()`),
});
