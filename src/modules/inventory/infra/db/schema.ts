/**
 * inventory スキーマ。テーブルは必ずこのスキーマに属させる。
 *
 * 責務: 原材料在庫と製品ロット、発注点
 *
 * 他モジュールのスキーマには USAGE すら無いので、ここから外部キーや JOIN を
 * 張ることはできない (境界の強制 2/3)。他文脈のものは識別子だけを持つ。
 * `product_id` は catalog の商品 ID、`lot_code` (製品) は production が付けたコード。
 * 商品名も価格もレシピもここには持たない。
 *
 * **原材料在庫と製品在庫はテーブルを分ける。** 性質が全く違うため。
 *
 * | | 原材料 (ingredients / ingredient_lots) | 製品 (product_lots) |
 * |---|---|---|
 * | 単位 | g / ml | piece |
 * | 賞味期限 | 日〜週単位 | 当日限り |
 * | 廃棄 | 期限切れ | 売れ残りで毎日 |
 * | ロット | 仕入先のロット番号 | production が付けたロットコード |
 * | 発注点 | ある | ない (製造計画が決める) |
 *
 * outbox / inbox は全モジュール共通の形なので shared/tables.ts から生やす。
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { moduleBaseTables } from "../../../../shared/tables.ts";

const base = moduleBaseTables("inventory");

export const inventorySchema = base.schema;
export const outbox = base.outbox;
export const inbox = base.inbox;

/**
 * 数量の精度。
 *
 * 原材料は g / ml で運ぶ (shared/events.ts の契約)。float だと 9.8kg のような
 * 端数の足し引きで誤差が出るので numeric を使う。小数3桁 = 1mg / 1μL まで。
 * 製品は個数だが、同じ丸め規則で扱えるように列の型は揃えておく。
 */
const AMOUNT = { precision: 14, scale: 3 } as const;

/**
 * 原材料。`id` は **inventory が採番する**。purchasing と production はこれを
 * 識別子としてだけ持つ。
 *
 * `on_hand` が帳簿在庫で、**マイナスになり得る**。結果整合なので販売確定が
 * 製造完了より先に届くことがあり、それを例外にすると再送が止まらなくなる。
 * マイナスはアラート (listStockAlerts) として扱い、棚卸で補正する。
 */
export const ingredients = inventorySchema.table(
  "ingredients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** g / ml / piece。登録後は変えない (既存の在庫数の意味が変わるため)。 */
    unit: text("unit").notNull(),
    onHandAmount: numeric("on_hand_amount", AMOUNT).notNull().default("0"),
    /** 0 は「発注点なし」。 */
    reorderPointAmount: numeric("reorder_point_amount", AMOUNT).notNull(),
    /**
     * 直前の評価で発注点を下回っていたか。
     *
     * 発注点割れイベントを「下回っている間ずっと」出さないための状態。
     * 上回る → 下回る に変わった瞬間だけ発行する (エッジトリガ)。
     * purchasing 側も未対応の提案を1件までに絞っているが、発行側でも抑制する。
     */
    belowReorderPoint: boolean("below_reorder_point").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 同名の原材料が2つあると、棚卸でどちらを数えたのか分からなくなる。
    uniqueIndex("ingredients_name_idx").on(table.name),
  ],
);

/**
 * 原材料のロット。仕入先のロット番号と賞味期限を持つ。
 *
 * `remaining_amount` の合計は `ingredients.on_hand` を超えない。入荷していない
 * ものを消費したときは帳簿在庫だけがマイナスに振れ、ロット側は 0 で止まる
 * (入ってきていないモノを「使った」ことにはできないため)。
 */
export const ingredientLots = inventorySchema.table(
  "ingredient_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ingredientId: uuid("ingredient_id")
      .notNull()
      .references(() => ingredients.id, { onDelete: "cascade" }),
    /** 仕入先のロット番号。トレーサビリティ用。inventory は採番しない。 */
    lotCode: text("lot_code").notNull(),
    /** 日付のみ。時刻を持たせると日跨ぎの解釈が実装ごとに割れる。 */
    bestBefore: date("best_before").notNull(),
    receivedAmount: numeric("received_amount", AMOUNT).notNull(),
    remainingAmount: numeric("remaining_amount", AMOUNT).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // FEFO (賞味期限の早い順) で引き当てるための並び。残量 0 のロットは読まない。
    index("ingredient_lots_fefo_idx")
      .on(table.ingredientId, table.bestBefore, table.receivedAt)
      .where(sql`${table.remainingAmount} <> 0`),
  ],
);

/**
 * 製品ロット。「今朝焼いた24個」がこれ。
 *
 * 主キーが `lot_code` なのは、これが production の付けた識別子で、inventory が
 * 採番し直す理由が無いため。当日限りなので賞味期限は基本翌日以前。
 */
export const productLots = inventorySchema.table(
  "product_lots",
  {
    lotCode: text("lot_code").primaryKey(),
    /** catalog の商品 ID。名前も価格もここには持たない。 */
    productId: uuid("product_id").notNull(),
    /** 個数。売れ残りは翌日に持ち越さないので、日次で 0 (廃棄) に落ちる。 */
    onHandAmount: numeric("on_hand_amount", AMOUNT).notNull().default("0"),
    bestBefore: date("best_before").notNull(),
    producedAt: timestamp("produced_at", { withTimezone: true }).notNull(),
    /**
     * 製造完了より先に販売確定が届いたときに作った仮の行か。
     * 製造完了が後から届いた時点で false になり、製造日と賞味期限が本物に直る。
     */
    provisional: boolean("provisional").notNull().default(false),
  },
  (table) => [index("product_lots_product_idx").on(table.productId, table.bestBefore)],
);

/** 棚卸1回分。 */
export const stocktakes = inventorySchema.table("stocktakes", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** 数えた時刻。記録した時刻ではない。 */
  countedAt: timestamp("counted_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 棚卸の明細。**差分を必ず残す。**
 *
 * 実地の数で上書きするだけだと、毎回 2kg 足りていても誰も気づかない。
 * 帳簿・実地・差分の3つを残して、後からズレを追えるようにする。
 */
export const stocktakeLines = inventorySchema.table(
  "stocktake_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stocktakeId: uuid("stocktake_id")
      .notNull()
      .references(() => stocktakes.id, { onDelete: "cascade" }),
    /** 'ingredient' | 'product_lot'。原材料と製品でモデルが違うので対象を明示する。 */
    targetKind: text("target_kind").notNull(),
    ingredientId: uuid("ingredient_id"),
    lotCode: text("lot_code"),
    /** 棚卸前の帳簿在庫。 */
    bookAmount: numeric("book_amount", AMOUNT).notNull(),
    /** 数えた在庫。これが新しい基準になる。 */
    countedAmount: numeric("counted_amount", AMOUNT).notNull(),
    /** counted - book。負なら記録漏れの消費、正なら記録漏れの入庫。 */
    diffAmount: numeric("diff_amount", AMOUNT).notNull(),
    unit: text("unit").notNull(),
  },
  (table) => [
    index("stocktake_lines_stocktake_idx").on(table.stocktakeId),
    index("stocktake_lines_ingredient_idx").on(table.ingredientId),
  ],
);
