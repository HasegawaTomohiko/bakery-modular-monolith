/**
 * 参照モデル (readmodel) のスキーマ。
 *
 * コンテキストをまたぐ画面 (今日の在庫と販売状況) は JOIN では作れない。
 * モジュールのスキーマには USAGE すら無く、そこを緩めるのは境界を壊すこと。
 * 代わりに、**イベントから組み立てた投影**をこのスキーマに持つ。
 *
 * readmodel はモジュール (境界づけられたコンテキスト) ではない。業務ロジックを
 * 持たず、購読して投影するだけ。したがって **outbox は持たない** (何も発行しない)。
 * inbox だけを shared/tables.ts から生やす。
 *
 * 投影は「イベントに載っている情報」だけで組む。商品名や原材料名はどのイベントにも
 * 載っていないので、ここには持てない (持とうとすると catalog / inventory に
 * 同期で問い合わせることになり、それが JOIN の代わりになってしまう)。
 * 画面に名前が要るなら、イベント契約を変える合意が先。
 *
 * 数値の持ち方:
 *   - 個数 (製造数・販売数) は integer。パンは 1 個の半分を売らない
 *   - 原材料の g / ml は numeric(14,3)。float だと端数の足し引きで誤差が出る
 *   - 金額は integer (日本円は小数を持たない)
 */
import {
  boolean,
  date,
  integer,
  numeric,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { moduleBaseTables } from "../../shared/tables.ts";

const base = moduleBaseTables("readmodel");

export const readmodelSchema = base.schema;
/** 配送は at-least-once。同じイベントを2回投影しないための受け皿。 */
export const inbox = base.inbox;

const AMOUNT = { precision: 14, scale: 3 } as const;

/**
 * 商品別の日次サマリ。ダッシュボードの主役。
 *
 * **売上と廃棄ロスを分けるのが「今日何を何個焼くか」**というのがこのドメインの芯なので、
 * 製造数と販売数を同じ行に並べ、差 (売れ残り = 当日限りなので廃棄) が一目で出るようにする。
 *
 * 製造は production.ProductionCompleted、販売は sales.SaleCompleted から積み上げる。
 * 2つのコンテキストの数字が1行に並ぶが、これは JOIN ではなく**投影**であり、
 * どちらのモジュールも相手を知らないまま成立している。
 */
export const dailyProductSummary = readmodelSchema.table(
  "daily_product_summary",
  {
    businessDate: date("business_date").notNull(),
    /** catalog の商品 ID。名前はイベントに載っていないので持てない。 */
    productId: uuid("product_id").notNull(),
    /** 焼き上がった個数の合計。 */
    producedPieces: integer("produced_pieces").notNull().default(0),
    /** 売れた個数の合計。 */
    soldPieces: integer("sold_pieces").notNull().default(0),
    /** 売上金額。販売時点の単価 × 個数をイベントから積む。 */
    salesJpy: integer("sales_jpy").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.businessDate, table.productId] })],
);

/**
 * 製品ロット別の日次サマリ。
 *
 * 廃棄は商品単位ではなく**ロット単位**で起きる (「今朝 6 時に焼いた 24 個」のうち
 * 6 個が残った)。商品別サマリだけだと、同じ商品を朝と昼に 2 回焼いたときに
 * どちらのロットが余ったのかが見えない。焼き直しの判断に効くので分けて持つ。
 */
export const dailyLotSummary = readmodelSchema.table(
  "daily_lot_summary",
  {
    businessDate: date("business_date").notNull(),
    /** production が付けたロットコード。 */
    lotCode: text("lot_code").notNull(),
    productId: uuid("product_id").notNull(),
    /** 当日限りなので基本は営業日と同じ。製造完了が届くまでは null。 */
    bestBefore: date("best_before"),
    producedPieces: integer("produced_pieces").notNull().default(0),
    soldPieces: integer("sold_pieces").notNull().default(0),
    salesJpy: integer("sales_jpy").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.businessDate, table.lotCode] })],
);

/**
 * 原材料の当日の動き。
 *
 * 入庫 (purchasing.GoodsReceiptAccepted) と消費 (production.ProductionCompleted の
 * consumedIngredients) を1行に並べる。発注点割れ (inventory.ReorderPointBreached) も
 * 同じ行に畳む。別表にすると「その日動いていないが発注点を割った原材料」を
 * 拾うのに外部結合が要るだけで、画面から見れば同じ1行だから。
 *
 * 在庫の**残高**は持たない。残高を持つのは inventory の仕事で、ここが持つと
 * 二重管理になる。ここに置くのはあくまで「当日どれだけ動いたか」。
 */
export const dailyIngredientFlow = readmodelSchema.table(
  "daily_ingredient_flow",
  {
    businessDate: date("business_date").notNull(),
    /** inventory が採番した原材料 ID。名前はイベントに載っていないので持てない。 */
    ingredientId: uuid("ingredient_id").notNull(),
    /** g / ml。イベントの単位をそのまま採る (換算表を持たない)。 */
    unit: text("unit").notNull(),
    receivedAmount: numeric("received_amount", AMOUNT).notNull().default("0"),
    consumedAmount: numeric("consumed_amount", AMOUNT).notNull().default("0"),
    /** 当日その原材料が発注点を割ったか。 */
    reorderBreached: boolean("reorder_breached").notNull().default(false),
    /** 割ったときの在庫・発注点・提案量。後から判断の妥当性を追えるように残す。 */
    breachOnHandAmount: numeric("breach_on_hand_amount", AMOUNT),
    breachReorderPointAmount: numeric("breach_reorder_point_amount", AMOUNT),
    breachSuggestedAmount: numeric("breach_suggested_amount", AMOUNT),
    breachDetectedAt: timestamp("breach_detected_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.businessDate, table.ingredientId] })],
);

/**
 * 販売停止になった商品。
 *
 * 日付ではなく商品に紐づく状態なので、日次の表とは別に持って画面側で重ねる。
 * catalog.ProductDelisted に載っているのは ID と理由と時刻だけ。名前を出したいなら
 * catalog に同期で問い合わせることになるが、それは参照モデルの役目ではない。
 */
export const delistedProducts = readmodelSchema.table("delisted_products", {
  productId: uuid("product_id").primaryKey(),
  delistedAt: timestamp("delisted_at", { withTimezone: true }).notNull(),
  /** discontinued / seasonal / supply_shortage / other。 */
  reason: text("reason").notNull(),
});
