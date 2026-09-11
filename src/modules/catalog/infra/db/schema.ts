/**
 * catalog スキーマ。テーブルは必ずこのスキーマに属させる。
 *
 * 責務: 販売用の商品定義、価格、販売状態、表示情報
 *
 * 他モジュールのスキーマには USAGE すら無いので、ここから外部キーや JOIN を
 * 張ることはできない (境界の強制 2/3)。他文脈のものは識別子だけを持つ。
 * この2テーブルにレシピも在庫数も賞味期限も出てこないのはそのため。
 *
 * outbox / inbox は全モジュール共通の形なので shared/tables.ts から生やす。
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { moduleBaseTables } from "../../../../shared/tables.ts";
import { ALLERGENS } from "../../domain/allergen.ts";

const base = moduleBaseTables("catalog");

export const catalogSchema = base.schema;
export const outbox = base.outbox;
export const inbox = base.inbox;

/** 特定原材料の許容値。CHECK 制約の右辺に埋め込む。 */
const allergenList = sql.raw(ALLERGENS.map((allergen) => `'${allergen}'`).join(", "));

/**
 * 商品。価格は持たない (履歴として product_prices が持つ)。
 *
 * 販売停止しても行は消さない。過去の売上・製造実績が productId で参照しており、
 * 消すと他モジュールの過去データが解決できなくなるため。
 */
export const products = catalogSchema.table(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /**
     * 特定原材料。表示義務があるので NOT NULL、既定値は置かない。
     * 既定値を置くと「入力し忘れ」が「該当なし」として静かに保存され、表示漏れになる。
     * enum 型ではなく text[] にしてあるのは、品目が法令で増えたときに
     * ALTER TYPE を伴うマイグレーションを他モジュールと同時に流さずに済ませるため。
     */
    allergens: text("allergens").array().notNull(),
    sellable: boolean("sellable").notNull().default(true),
    delistedAt: timestamp("delisted_at", { withTimezone: true }),
    delistReason: text("delist_reason"),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // listSellableProducts が毎回引く条件。
    index("products_sellable_idx").on(table.sellable),
    check("products_name_not_blank", sql`length(btrim(${table.name})) > 0`),
    // アプリを経由しない手作業の INSERT でも表示事故が起きないようにする。
    check("products_allergens_known", sql`${table.allergens} <@ ARRAY[${allergenList}]::text[]`),
    // 販売停止なら理由と日時が揃っている。片方だけの状態を許すとイベントと矛盾する。
    check(
      "products_delist_consistent",
      sql`(${table.sellable} AND ${table.delistedAt} IS NULL AND ${table.delistReason} IS NULL)
          OR (NOT ${table.sellable} AND ${table.delistedAt} IS NOT NULL AND ${table.delistReason} IS NOT NULL)`,
    ),
  ],
);

/**
 * 価格履歴。「いつからいくらか」を持つ。
 *
 * 現在価格だけを上書きで持つと、価格改定した瞬間に過去の売上を再計算できなくなる。
 * 追記しかしないので、改定してもレシートの過去の金額は動かない。
 */
export const productPrices = catalogSchema.table(
  "product_prices",
  {
    // 同一スキーマ内なので外部キーを張れる。境界をまたがない参照は積極的に張る。
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    priceJpy: integer("price_jpy").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  },
  (table) => [
    // 同じ商品の同じ時刻に2つの定価は存在しない。
    primaryKey({ columns: [table.productId, table.effectiveFrom] }),
    check("product_prices_positive", sql`${table.priceJpy} > 0`),
  ],
);
