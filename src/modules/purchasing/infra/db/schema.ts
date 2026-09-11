/**
 * purchasing スキーマ。テーブルは必ずこのスキーマに属させる。
 *
 * 責務: 仕入先、発注、入荷・検収
 *
 * 他モジュールのスキーマには USAGE すら無いので、ここから外部キーや JOIN を
 * 張ることはできない (境界の強制 2/3)。他文脈のものは識別子だけを持つ。
 * `ingredient_id` は inventory が採番した uuid だが、外部キーは張らない。
 * 原材料の名前も在庫数もここには持たない。必要なら inventory の公開ユースケースに
 * 同期で問い合わせる。
 *
 * outbox / inbox は全モジュール共通の形なので shared/tables.ts から生やす。
 */
import { sql } from "drizzle-orm";
import {
  date,
  index,
  integer,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { moduleBaseTables } from "../../../../shared/tables.ts";

const base = moduleBaseTables("purchasing");

export const purchasingSchema = base.schema;
export const outbox = base.outbox;
export const inbox = base.inbox;

/**
 * 数量の精度。
 *
 * 原材料は g / ml で運ぶ (shared/events.ts の契約)。float だと 9.8kg のような
 * 端数の足し引きで誤差が出るので numeric を使う。小数3桁 = 1mg / 1μL まで。
 */
const AMOUNT = { precision: 14, scale: 3 } as const;

export const suppliers = purchasingSchema.table("suppliers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** 発注提案を人が判断するときの材料。何日前に頼めば間に合うか。 */
  leadTimeDays: integer("lead_time_days").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const purchaseOrders = purchasingSchema.table(
  "purchase_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    /** placed / received / accepted / cancelled。received と accepted は別物。 */
    status: text("status").notNull(),
    orderedAt: timestamp("ordered_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("purchase_orders_supplier_idx").on(table.supplierId)],
);

export const purchaseOrderLines = purchasingSchema.table(
  "purchase_order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    /** inventory が採番した識別子。外部キーは張らない (張れない)。 */
    ingredientId: uuid("ingredient_id").notNull(),
    amount: numeric("amount", AMOUNT).notNull(),
    unit: text("unit").notNull(),
    /** 入力された明細の順序を保つ。表示のたびに並びが変わらないようにするため。 */
    lineNo: integer("line_no").notNull(),
  },
  (table) => [
    uniqueIndex("purchase_order_lines_order_line_idx").on(table.purchaseOrderId, table.lineNo),
    // 1発注に同じ原材料が2行あると、入荷との突合が曖昧になる。
    uniqueIndex("purchase_order_lines_order_ingredient_idx").on(
      table.purchaseOrderId,
      table.ingredientId,
    ),
  ],
);

/**
 * 入荷。モノが届いた記録。
 * `accepted_at` が null の間は未検収で、在庫にはなっていない。
 */
export const goodsReceipts = purchasingSchema.table(
  "goods_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    /** null = 未検収。検収した瞬間に埋まり、同時にイベントが出る。 */
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (table) => [index("goods_receipts_order_idx").on(table.purchaseOrderId)],
);

export const goodsReceiptLines = purchasingSchema.table(
  "goods_receipt_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goodsReceiptId: uuid("goods_receipt_id")
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: "cascade" }),
    ingredientId: uuid("ingredient_id").notNull(),
    /** 発注数量ではなく**実際に届いた数量**。10kg 頼んで 9.8kg ならここは 9800g。 */
    amount: numeric("amount", AMOUNT).notNull(),
    unit: text("unit").notNull(),
    /** 仕入先のロット番号。トレーサビリティ用。 */
    lotCode: text("lot_code").notNull(),
    /** 原材料は日〜週単位の賞味期限を持つ。時刻は持たせない。 */
    bestBefore: date("best_before").notNull(),
    lineNo: integer("line_no").notNull(),
  },
  (table) => [
    uniqueIndex("goods_receipt_lines_receipt_line_idx").on(table.goodsReceiptId, table.lineNo),
    uniqueIndex("goods_receipt_lines_receipt_ingredient_idx").on(
      table.goodsReceiptId,
      table.ingredientId,
    ),
  ],
);

/**
 * 発注点割れから作られた提案。
 *
 * 自動発注はしない。仕入先ごとのリードタイムと最小ロットが絡むので、確定は人に残す。
 */
export const purchaseSuggestions = purchasingSchema.table(
  "purchase_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ingredientId: uuid("ingredient_id").notNull(),
    suggestedAmount: numeric("suggested_amount", AMOUNT).notNull(),
    suggestedUnit: text("suggested_unit").notNull(),
    /** 発注点を割ったと検知した時点の在庫。後から判断の妥当性を追えるように残す。 */
    onHandAmount: numeric("on_hand_amount", AMOUNT).notNull(),
    onHandUnit: text("on_hand_unit").notNull(),
    /** open / ordered / rejected。 */
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /** ordered になったときの発注 ID。 */
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    /**
     * 1原材料につき「未対応」は1件まで。
     *
     * イベントは at-least-once なので同じ発注点割れが2回届きうるし、在庫が
     * 発注点付近を行き来すれば業務的にも何度でも飛んでくる。アプリ側の事前
     * チェックだけだと同時に届いたときに2件入るので、DB の制約で担保する。
     * ordered / rejected は履歴として何件でも残ってよいので部分インデックス。
     */
    uniqueIndex("purchase_suggestions_open_ingredient_idx")
      .on(table.ingredientId)
      .where(sql`${table.status} = 'open'`),
    index("purchase_suggestions_status_idx").on(table.status, table.createdAt),
  ],
);
