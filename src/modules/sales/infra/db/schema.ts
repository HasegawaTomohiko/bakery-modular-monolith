/**
 * sales スキーマ。テーブルは必ずこのスキーマに属させる。
 *
 * 責務: 店頭販売、予約注文、売上
 *
 * 他モジュールのスキーマには USAGE すら無いので、ここから外部キーや JOIN を
 * 張ることはできない (境界の強制 2/3)。他文脈のものは識別子だけを持つ。
 *
 * この 2 つは特に守ること:
 *   - **在庫数を持たない。** sales は在庫を持たず、どのロットを売ったかを
 *     イベントで伝えるだけ。出庫と残数の管理は inventory の責務
 *   - **商品名・アレルゲン・現在価格を持たない。** それらは catalog の持ち物で、
 *     必要なときに同期で問い合わせる。持つのは商品識別子と、販売時点で焼き付けた単価だけ
 *
 * outbox / inbox は全モジュール共通の形なので shared/tables.ts から生やす。
 */
import { boolean, date, index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { moduleBaseTables } from "../../../../shared/tables.ts";

const base = moduleBaseTables("sales");

export const salesSchema = base.schema;
export const outbox = base.outbox;
export const inbox = base.inbox;

/** 販売経路。イベント契約の `channel` と同じ値域。 */
export const saleChannel = salesSchema.enum("sale_channel", ["storefront", "reservation"]);

export const reservationStatus = salesSchema.enum("reservation_status", [
  "placed",
  "fulfilled",
  "cancelled",
]);

/**
 * 販売 (レシート 1 枚)。
 * `business_date` は `sold_at` から算出した営業日 (JST の暦日)。日次集計のたびに
 * タイムゾーン計算をやり直さないよう、書き込み時に確定させて持つ。
 */
export const saleRecords = salesSchema.table(
  "sales",
  {
    id: uuid("id").primaryKey(),
    channel: saleChannel("channel").notNull(),
    soldAt: timestamp("sold_at", { withTimezone: true }).notNull(),
    businessDate: date("business_date").notNull(),
    totalJpy: integer("total_jpy").notNull(),
    /** 予約由来の販売だけ埋まる。予約は sales の中の識別子なので参照してよい。 */
    reservationId: uuid("reservation_id").references(() => reservations.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sales_business_date_idx").on(table.businessDate)],
);

/**
 * レシートの 1 行。
 * `unit_price_jpy` は**販売時点の価格**。catalog の現在価格を後から引くと、
 * 価格改定のたびに過去の売上が変わってしまうのでここに焼き付ける。
 * `lot_code` は inventory のロット識別子で、sales は残数を知らない。
 */
export const saleLines = salesSchema.table(
  "sale_lines",
  {
    // 明細 ID は業務上の意味を持たないので DB 側で採番する。
    id: uuid("id").primaryKey().defaultRandom(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => saleRecords.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull(),
    lotCode: text("lot_code").notNull(),
    /** 製品は個数で数える。単位は piece 固定なので列に持たない。 */
    quantityPieces: integer("quantity_pieces").notNull(),
    unitPriceJpy: integer("unit_price_jpy").notNull(),
    subtotalJpy: integer("subtotal_jpy").notNull(),
  },
  (table) => [
    index("sale_lines_sale_idx").on(table.saleId),
    index("sale_lines_product_idx").on(table.productId),
  ],
);

/** 予約。受付時点では売上にしないので、金額を持たない。 */
export const reservations = salesSchema.table(
  "reservations",
  {
    id: uuid("id").primaryKey(),
    customerName: text("customer_name").notNull(),
    pickupDate: date("pickup_date").notNull(),
    status: reservationStatus("status").notNull().default("placed"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /** 引き渡しで作られた販売。引き渡し前は null。 */
    saleId: uuid("sale_id"),
  },
  (table) => [index("reservations_pickup_date_idx").on(table.pickupDate)],
);

/**
 * 予約明細。
 * ロットを持たないのは、受付時点ではまだ焼いていないため。ロットは引き渡しの瞬間に決まる。
 */
export const reservationLines = salesSchema.table(
  "reservation_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull(),
    quantityPieces: integer("quantity_pieces").notNull(),
  },
  (table) => [index("reservation_lines_reservation_idx").on(table.reservationId)],
);

/**
 * catalog の商品情報の**参照コピー**。
 *
 * 持つのは「売ってよいか」だけ。名前・価格・アレルゲンは catalog に同期で問い合わせる。
 * `catalog.ProductDelisted` を受け取った商品だけが行を持ち、行が無い商品は
 * 「停止されたと聞いていない」= 販売可として扱う。
 */
export const productSellability = salesSchema.table("product_sellability", {
  productId: uuid("product_id").primaryKey(),
  sellable: boolean("sellable").notNull(),
  delistedAt: timestamp("delisted_at", { withTimezone: true }),
  delistReason: text("delist_reason"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
