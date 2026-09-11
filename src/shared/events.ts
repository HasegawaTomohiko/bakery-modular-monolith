/**
 * コンテキスト間のイベント契約。
 *
 * ここがモジュール間の**唯一の**状態変化の伝達手段 (境界の強制 3/3)。
 * 同期の問い合わせは相手の公開ユースケース経由、状態変化の通知はこのイベントのみ。
 *
 * 契約なので、モジュールの実装より先に確定させる。並列にモジュールを実装するとき、
 * ここが動くと全員が巻き込まれるため、変更は全モジュールの合意が要る。
 *
 * | 発行元 | イベント | 購読先 | 購読側の処理 |
 * |---|---|---|---|
 * | purchasing | 検収済     | inventory            | 原材料を入庫 |
 * | inventory  | 発注点割れ | purchasing           | 発注提案を作成 |
 * | production | 製造完了   | inventory            | 原材料を消費し、製品ロットを入庫 |
 * | sales      | 販売確定   | inventory            | 製品を出庫 |
 * | sales      | 販売確定   | production           | 需要予測の入力として販売実績を記録 |
 * | catalog    | 販売停止   | production, sales    | 参照している商品情報を更新 |
 *
 * 整合性は結果整合。現実の在庫数は棚卸で補正する近似値であり、「製造完了と原材料消費が
 * 同一トランザクションで確定する」必要はない。在庫が一時的にマイナスになり得ることを
 * 許容し、アラートとして扱う。
 */
import { z } from "zod";
import type { ModuleName } from "./config.ts";

// ---------------------------------------------------------------------------
// 共有の値
// ---------------------------------------------------------------------------

/**
 * 数量。原材料は質量/体積、製品は個数で数える。
 * 単位は基本単位に正規化して運ぶ (kg ではなく g)。受け手が換算を持たないため。
 */
export const quantitySchema = z.object({
  amount: z.number().finite(),
  unit: z.enum(["g", "ml", "piece"]),
});
export type Quantity = z.infer<typeof quantitySchema>;

/** 日本円。小数を持たないので整数で扱う。 */
export const jpySchema = z.number().int();

/** 日付のみ (賞味期限・製造日)。時刻を持たせると日跨ぎの解釈が分かれるため。 */
export const isoDateSchema = z.iso.date();

/** 原材料の消費・入庫の1行。 */
export const ingredientLineSchema = z.object({
  ingredientId: z.uuid(),
  quantity: quantitySchema,
});

// ---------------------------------------------------------------------------
// purchasing → inventory : 検収済
// ---------------------------------------------------------------------------

/**
 * 仕入先からの入荷を検収した。
 * inventory はこれを受けて原材料を入庫する。
 */
export const goodsReceiptAcceptedSchema = z.object({
  goodsReceiptId: z.uuid(),
  purchaseOrderId: z.uuid(),
  supplierId: z.uuid(),
  acceptedAt: z.iso.datetime({ offset: true }),
  lines: z
    .array(
      ingredientLineSchema.extend({
        /** 仕入先のロット番号。トレーサビリティ用。 */
        lotCode: z.string().min(1),
        /** 原材料は日〜週単位の賞味期限を持つ。 */
        bestBefore: isoDateSchema,
      }),
    )
    .min(1),
});

// ---------------------------------------------------------------------------
// inventory → purchasing : 発注点割れ
// ---------------------------------------------------------------------------

/**
 * 原材料の在庫が発注点を下回った。
 * purchasing はこれを受けて発注提案を作る。発注そのものは人が確定させる。
 */
export const reorderPointBreachedSchema = z.object({
  ingredientId: z.uuid(),
  onHand: quantitySchema,
  reorderPoint: quantitySchema,
  suggestedOrderQuantity: quantitySchema,
  detectedAt: z.iso.datetime({ offset: true }),
});

// ---------------------------------------------------------------------------
// production → inventory : 製造完了
// ---------------------------------------------------------------------------

/**
 * 製造が完了した。
 *
 * 消費した原材料をイベントに載せるのは、レシピが production の持ち物だから。
 * inventory がレシピを引くと境界を越えることになるので、
 * 「レシピ×数量」の計算は発行側で終わらせて結果だけ渡す。
 */
export const productionCompletedSchema = z.object({
  productionRunId: z.uuid(),
  productionPlanId: z.uuid(),
  /** catalog の商品 ID。catalog を参照するのではなく、識別子だけを運ぶ。 */
  productId: z.uuid(),
  recipeId: z.uuid(),
  /** 焼き上がった個数。 */
  producedQuantity: quantitySchema,
  /** 製品ロット。当日焼いて当日売り切るので、寿命は基本1日。 */
  lotCode: z.string().min(1),
  bestBefore: isoDateSchema,
  completedAt: z.iso.datetime({ offset: true }),
  /** レシピ×数量から算出済みの原材料消費。 */
  consumedIngredients: z.array(ingredientLineSchema).min(1),
});

// ---------------------------------------------------------------------------
// sales → inventory, production : 販売確定
// ---------------------------------------------------------------------------

/**
 * 販売が確定した。購読先が2つある唯一のイベント。
 * - inventory: 製品を出庫する
 * - production: 需要予測の入力として販売実績を記録する
 */
export const saleCompletedSchema = z.object({
  saleId: z.uuid(),
  channel: z.enum(["storefront", "reservation"]),
  soldAt: z.iso.datetime({ offset: true }),
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        /** 出庫するロット。sales は在庫を持たないので、どのロットを売ったかだけ伝える。 */
        lotCode: z.string().min(1),
        quantity: quantitySchema,
        unitPriceJpy: jpySchema,
      }),
    )
    .min(1),
  totalJpy: jpySchema,
});

// ---------------------------------------------------------------------------
// catalog → production, sales : 販売停止
// ---------------------------------------------------------------------------

/**
 * 商品の販売を停止した。
 * production は製造計画から外し、sales は売れないようにする。
 *
 * 商品の名前・価格・アレルゲン表示といった内容は catalog の公開ユースケースに
 * 同期で問い合わせる。イベントで運ぶのは「状態が変わった」という事実だけ。
 */
export const productDelistedSchema = z.object({
  productId: z.uuid(),
  delistedAt: z.iso.datetime({ offset: true }),
  reason: z.enum(["discontinued", "seasonal", "supply_shortage", "other"]),
});

// ---------------------------------------------------------------------------
// レジストリ
// ---------------------------------------------------------------------------

/**
 * イベント名は `<発行元モジュール>.<イベント>` で一意にする。
 * 発行元がひと目で分かるようにするため。
 */
export const eventSchemas = {
  "purchasing.GoodsReceiptAccepted": goodsReceiptAcceptedSchema,
  "inventory.ReorderPointBreached": reorderPointBreachedSchema,
  "production.ProductionCompleted": productionCompletedSchema,
  "sales.SaleCompleted": saleCompletedSchema,
  "catalog.ProductDelisted": productDelistedSchema,
} as const;

export type EventName = keyof typeof eventSchemas;

export type EventPayload<N extends EventName> = z.infer<(typeof eventSchemas)[N]>;

/** イベント名から発行元モジュールを取り出す。ルーティングの検証に使う。 */
export function publisherOf(name: EventName): ModuleName {
  return name.split(".")[0] as ModuleName;
}

export function isEventName(value: string): value is EventName {
  return Object.hasOwn(eventSchemas, value);
}

/** 配信されるイベント1件。id は outbox の行 ID で、購読側の冪等キーになる。 */
export type EventEnvelope<N extends EventName = EventName> = {
  readonly id: string;
  readonly name: N;
  readonly payload: EventPayload<N>;
  readonly occurredAt: Date;
};

/** どのイベントか分からない文脈で扱うための直和。 */
export type DomainEvent = { [N in EventName]: EventEnvelope<N> }[EventName];

/** 保存されていた JSON を契約に照らして復元する。契約外なら例外。 */
export function parseEventPayload<N extends EventName>(name: N, payload: unknown): EventPayload<N> {
  return eventSchemas[name].parse(payload) as EventPayload<N>;
}
