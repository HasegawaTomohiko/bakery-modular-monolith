/**
 * イベント → 参照モデルへの投影。
 *
 * ここが readmodel の入口であり、**唯一の書き込み経路**。入力は
 * `src/shared/events.ts` の契約だけで、モジュールには一切触れない
 * (触れたら、そこが JOIN の代わりになってしまう)。
 *
 * 冪等性は shared/inbox.ts が (event_id, handler) で担保する。投影は
 * event-bus が開いた inbox のトランザクションに相乗りするので、
 * 「積んだが処理済みにできていない」も「処理済みだが積めていない」も起きない。
 * したがって各投影は「素直に足し込む」だけでよく、自前の重複判定は要らない。
 *
 * 投影は例外を投げない。参照モデルの1行のために配送を止めると、発行側の outbox に
 * published 印が付かず同じイベントが永久に再送されて worker が詰まる。
 * 画面が少し欠けることより、業務の配送経路が生きていることを優先する。
 */
import { sql } from "drizzle-orm";
import { defineSubscription, type Subscription } from "../shared/event-bus.ts";
import type { Quantity } from "../shared/events.ts";
import type { Executor } from "../shared/tables.ts";
import { businessDateOf } from "./business-date.ts";
import {
  dailyIngredientFlow,
  dailyLotSummary,
  dailyProductSummary,
  delistedProducts,
} from "./db/schema.ts";

/**
 * 個数に落とす。パンは 1 個の半分を売らないので整数に丸める。
 *
 * 単位が piece でなくても弾かない (投影を止めない)。契約上ここに来るのは piece だけで、
 * 違うものが来ているならそれは発行側の不具合であって、参照モデルが配送を
 * 止めて直せる類のものではない。
 */
function toPieces(quantity: Quantity): number {
  return Math.round(quantity.amount);
}

/** numeric 列へは文字列で渡す。float を経由させて丸め誤差を持ち込まないため。 */
function toAmount(quantity: Quantity): string {
  return quantity.amount.toFixed(3);
}

type ProductDelta = {
  readonly producedPieces?: number;
  readonly soldPieces?: number;
  readonly salesJpy?: number;
};

/** 商品別サマリに足し込む。無ければ作る。 */
async function addToProductSummary(
  tx: Executor,
  businessDate: string,
  productId: string,
  delta: ProductDelta,
): Promise<void> {
  await tx
    .insert(dailyProductSummary)
    .values({
      businessDate,
      productId,
      producedPieces: delta.producedPieces ?? 0,
      soldPieces: delta.soldPieces ?? 0,
      salesJpy: delta.salesJpy ?? 0,
    })
    .onConflictDoUpdate({
      target: [dailyProductSummary.businessDate, dailyProductSummary.productId],
      set: {
        producedPieces: sql`${dailyProductSummary.producedPieces} + excluded.produced_pieces`,
        soldPieces: sql`${dailyProductSummary.soldPieces} + excluded.sold_pieces`,
        salesJpy: sql`${dailyProductSummary.salesJpy} + excluded.sales_jpy`,
        updatedAt: sql`now()`,
      },
    });
}

/** ロット別サマリに足し込む。無ければ作る。 */
async function addToLotSummary(
  tx: Executor,
  params: {
    readonly businessDate: string;
    readonly lotCode: string;
    readonly productId: string;
    readonly bestBefore: string | null;
    readonly delta: ProductDelta;
  },
): Promise<void> {
  await tx
    .insert(dailyLotSummary)
    .values({
      businessDate: params.businessDate,
      lotCode: params.lotCode,
      productId: params.productId,
      bestBefore: params.bestBefore,
      producedPieces: params.delta.producedPieces ?? 0,
      soldPieces: params.delta.soldPieces ?? 0,
      salesJpy: params.delta.salesJpy ?? 0,
    })
    .onConflictDoUpdate({
      target: [dailyLotSummary.businessDate, dailyLotSummary.lotCode],
      set: {
        producedPieces: sql`${dailyLotSummary.producedPieces} + excluded.produced_pieces`,
        soldPieces: sql`${dailyLotSummary.soldPieces} + excluded.sold_pieces`,
        salesJpy: sql`${dailyLotSummary.salesJpy} + excluded.sales_jpy`,
        // 賞味期限が分かるのは製造完了だけ。販売が先に届いても null で潰さない。
        bestBefore: sql`coalesce(excluded.best_before, ${dailyLotSummary.bestBefore})`,
        updatedAt: sql`now()`,
      },
    });
}

/** 原材料の動きに足し込む。無ければ作る。 */
async function addToIngredientFlow(
  tx: Executor,
  params: {
    readonly businessDate: string;
    readonly ingredientId: string;
    readonly quantity: Quantity;
    readonly direction: "received" | "consumed";
  },
): Promise<void> {
  const amount = toAmount(params.quantity);
  const received = params.direction === "received" ? amount : "0";
  const consumed = params.direction === "consumed" ? amount : "0";

  await tx
    .insert(dailyIngredientFlow)
    .values({
      businessDate: params.businessDate,
      ingredientId: params.ingredientId,
      unit: params.quantity.unit,
      receivedAmount: received,
      consumedAmount: consumed,
    })
    .onConflictDoUpdate({
      target: [dailyIngredientFlow.businessDate, dailyIngredientFlow.ingredientId],
      set: {
        receivedAmount: sql`${dailyIngredientFlow.receivedAmount} + excluded.received_amount`,
        consumedAmount: sql`${dailyIngredientFlow.consumedAmount} + excluded.consumed_amount`,
        // 単位は先に記録されたものを正とする。同じ原材料の単位が日中に変わることはない。
        updatedAt: sql`now()`,
      },
    });
}

// ---------------------------------------------------------------------------
// 購読
// ---------------------------------------------------------------------------

/**
 * 参照モデルの購読表。5イベントすべてを入力にする。
 *
 * | イベント | 投影先 |
 * |---|---|
 * | purchasing.GoodsReceiptAccepted | 原材料の入庫 |
 * | production.ProductionCompleted  | 製造数 (商品別・ロット別) と原材料の消費 |
 * | sales.SaleCompleted             | 販売数・売上 (商品別・ロット別) |
 * | inventory.ReorderPointBreached  | 発注点割れの印 |
 * | catalog.ProductDelisted         | 販売停止の印 |
 */
export const readmodelSubscriptions: readonly Subscription[] = [
  defineSubscription({
    subscriber: "readmodel",
    handler: "project-goods-receipt",
    eventName: "purchasing.GoodsReceiptAccepted",
    // 検収した日を入庫日とする。発注日でも入荷日でもなく、在庫になった日。
    handle: async (event, tx) => {
      const businessDate = businessDateOf(event.payload.acceptedAt);
      for (const line of event.payload.lines) {
        await addToIngredientFlow(tx, {
          businessDate,
          ingredientId: line.ingredientId,
          quantity: line.quantity,
          direction: "received",
        });
      }
    },
  }),

  defineSubscription({
    subscriber: "readmodel",
    handler: "project-production-completed",
    eventName: "production.ProductionCompleted",
    // 製造数と、そのとき消費した原材料。消費量はイベントに載っている値をそのまま使う
    // (レシピは production の持ち物で、参照モデルが引ける場所ではない)。
    handle: async (event, tx) => {
      const payload = event.payload;
      const businessDate = businessDateOf(payload.completedAt);
      const producedPieces = toPieces(payload.producedQuantity);

      await addToProductSummary(tx, businessDate, payload.productId, { producedPieces });
      await addToLotSummary(tx, {
        businessDate,
        lotCode: payload.lotCode,
        productId: payload.productId,
        bestBefore: payload.bestBefore,
        delta: { producedPieces },
      });

      for (const line of payload.consumedIngredients) {
        await addToIngredientFlow(tx, {
          businessDate,
          ingredientId: line.ingredientId,
          quantity: line.quantity,
          direction: "consumed",
        });
      }
    },
  }),

  defineSubscription({
    subscriber: "readmodel",
    handler: "project-sale-completed",
    eventName: "sales.SaleCompleted",
    // 販売数と売上。金額は販売時点の単価 × 個数で、後から catalog の価格が変わっても動かない。
    handle: async (event, tx) => {
      const payload = event.payload;
      const businessDate = businessDateOf(payload.soldAt);

      for (const line of payload.lines) {
        const soldPieces = toPieces(line.quantity);
        const salesJpy = line.unitPriceJpy * soldPieces;

        await addToProductSummary(tx, businessDate, line.productId, { soldPieces, salesJpy });
        await addToLotSummary(tx, {
          businessDate,
          lotCode: line.lotCode,
          productId: line.productId,
          // 販売確定には賞味期限が載っていない。製造完了が届いたときに埋まる。
          bestBefore: null,
          delta: { soldPieces, salesJpy },
        });
      }
    },
  }),

  defineSubscription({
    subscriber: "readmodel",
    handler: "project-reorder-point-breached",
    eventName: "inventory.ReorderPointBreached",
    // 発注点割れは当日の原材料の行に畳む。別表にすると、その日動いていない原材料の
    // 割れを拾うのに外部結合が要るだけで、画面から見れば同じ1行だから。
    handle: async (event, tx) => {
      const payload = event.payload;
      const businessDate = businessDateOf(payload.detectedAt);
      const breach = {
        reorderBreached: true,
        breachOnHandAmount: toAmount(payload.onHand),
        breachReorderPointAmount: toAmount(payload.reorderPoint),
        breachSuggestedAmount: toAmount(payload.suggestedOrderQuantity),
        breachDetectedAt: new Date(payload.detectedAt),
      } as const;

      await tx
        .insert(dailyIngredientFlow)
        .values({
          businessDate,
          ingredientId: payload.ingredientId,
          unit: payload.onHand.unit,
          ...breach,
        })
        .onConflictDoUpdate({
          target: [dailyIngredientFlow.businessDate, dailyIngredientFlow.ingredientId],
          // 同じ日に2回割れたら最後の1回を残す。人が見るのは「今いくつ足りないか」なので。
          set: { ...breach, updatedAt: sql`now()` },
        });
    },
  }),

  defineSubscription({
    subscriber: "readmodel",
    handler: "project-product-delisted",
    eventName: "catalog.ProductDelisted",
    // 販売停止は日付ではなく商品に紐づく状態。日次の表とは別に持ち、画面側で重ねる。
    handle: async (event, tx) => {
      const payload = event.payload;
      await tx
        .insert(delistedProducts)
        .values({
          productId: payload.productId,
          delistedAt: new Date(payload.delistedAt),
          reason: payload.reason,
        })
        .onConflictDoUpdate({
          target: delistedProducts.productId,
          set: { delistedAt: new Date(payload.delistedAt), reason: payload.reason },
        });
    },
  }),
];
