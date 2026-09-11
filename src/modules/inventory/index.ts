/**
 * inventory モジュールの公開 API (支援)。
 *
 * 責務: 原材料在庫と製品ロット、発注点
 *
 * **原材料在庫と製品在庫はモデルを分ける。** 原材料は g/ml 単位で日〜週単位の
 * 賞味期限を持ち、製品は個数で当日限り・廃棄がある。性質が違うので同じ表にしない。
 *
 * ここでの「クロワッサン」は「今朝焼いた24個」という**ロット**であり、
 * catalog の販売物とも production のレシピとも別のもの。
 *
 * 在庫数は棚卸で補正する近似値。結果整合なので一時的にマイナスになり得る。
 * それはエラーではなくアラートとして扱う (listStockAlerts)。
 *
 * 公開シグネチャは Phase 4a で確定した契約。実装 (Phase 4b) で変えないこと。
 */
import { defineSubscription, type Subscription } from "../../shared/event-bus.ts";
import type { Quantity } from "../../shared/events.ts";
import {
  consumeAndStockProduction,
  receiveAcceptedGoods,
  shipSoldProducts,
} from "./application/handlers.ts";
import * as useCases from "./application/use-cases.ts";
import { transaction, unitOfWorkFor } from "./infra/unit-of-work.ts";

/**
 * ユースケースに渡す外側の口。ここが唯一の組み立て場所。
 * application/ は drizzle も pg も知らないので、単体テストでは別の deps を渡せる。
 */
const deps = { transaction, now: () => new Date() } as const;

// ---------------------------------------------------------------------------
// 公開型
// ---------------------------------------------------------------------------

export type IngredientId = string;
/** 製品ロットは production が付けたロットコードで識別する。 */
export type LotCode = string;

/** 原材料在庫。質量/体積で数え、賞味期限を持つ。 */
export type IngredientStockView = {
  readonly ingredientId: IngredientId;
  readonly name: string;
  readonly onHand: Quantity;
  readonly reorderPoint: Quantity;
  /** 手持ちの中で最も早い賞味期限。無ければ null。 */
  readonly nearestBestBefore: string | null;
};

/** 製品ロット。個数で数え、基本1日で寿命が尽きる。 */
export type ProductLotView = {
  readonly lotCode: LotCode;
  readonly productId: string;
  readonly onHand: Quantity;
  readonly bestBefore: string;
  readonly producedAt: string;
};

/** 在庫の異常。落とさずに知らせる。 */
export type StockAlert =
  | {
      readonly kind: "negative_ingredient_stock";
      readonly ingredientId: IngredientId;
      readonly onHand: Quantity;
    }
  | {
      readonly kind: "negative_product_stock";
      readonly lotCode: LotCode;
      readonly onHand: Quantity;
    }
  | {
      readonly kind: "expired_ingredient";
      readonly ingredientId: IngredientId;
      readonly bestBefore: string;
    };

export type RegisterIngredientInput = {
  readonly name: string;
  readonly unit: Quantity["unit"];
  readonly reorderPoint: Quantity;
};

export type SetReorderPointInput = {
  readonly ingredientId: IngredientId;
  readonly reorderPoint: Quantity;
};

/** 棚卸。実地の数で在庫を上書きする。差分は記録する。 */
export type RecordStocktakeInput = {
  readonly countedAt: string;
  readonly ingredients: readonly {
    readonly ingredientId: IngredientId;
    readonly counted: Quantity;
  }[];
  readonly productLots: readonly { readonly lotCode: LotCode; readonly counted: Quantity }[];
};

// ---------------------------------------------------------------------------
// 公開ユースケース
// ---------------------------------------------------------------------------

export const inventory = {
  registerIngredient(input: RegisterIngredientInput): Promise<IngredientId> {
    return useCases.registerIngredient(deps, input);
  },

  /** 発注点を設定する。下回ると `inventory.ReorderPointBreached` を発行する。 */
  setReorderPoint(input: SetReorderPointInput): Promise<void> {
    return useCases.setReorderPoint(deps, input);
  },

  getIngredientStock(ingredientId: IngredientId): Promise<IngredientStockView | null> {
    return useCases.getIngredientStock(deps, ingredientId);
  },

  listIngredientStock(): Promise<readonly IngredientStockView[]> {
    return useCases.listIngredientStock(deps);
  },

  listProductLots(): Promise<readonly ProductLotView[]> {
    return useCases.listProductLots(deps);
  },

  /** 現実とのズレを補正する。在庫が近似値であることを前提にした唯一の正攻法。 */
  recordStocktake(input: RecordStocktakeInput): Promise<void> {
    return useCases.recordStocktake(deps, input);
  },

  listStockAlerts(): Promise<readonly StockAlert[]> {
    return useCases.listStockAlerts(deps);
  },
} as const;

// ---------------------------------------------------------------------------
// 購読
// ---------------------------------------------------------------------------

/**
 * inventory は5イベント中3つを購読する (購読が最も多いモジュール)。
 *
 * どのハンドラも `tx` を event-bus からそのまま受け取り、新しいトランザクションを
 * 開かない。inbox への記録とハンドラの処理が同じトランザクションでなくなると、
 * 「処理したが記録できていない」= 二重処理が起きるため。
 *
 * ハンドラは業務的な異常 (在庫がマイナス、知らない原材料 ID) で例外を投げない。
 * 投げると発行側の outbox に published 印が付かず、同じイベントが永久に再送されて
 * worker が詰まる。異常はアラートとして listStockAlerts に出す。
 */
export const inventorySubscriptions: readonly Subscription[] = [
  defineSubscription({
    subscriber: "inventory",
    handler: "receive-accepted-goods",
    eventName: "purchasing.GoodsReceiptAccepted",
    // 原材料を入庫する。仕入先のロット番号と賞味期限ごとロットとして持つ。
    handle: async (event, tx) => {
      await receiveAcceptedGoods(unitOfWorkFor(tx), event.payload);
    },
  }),
  defineSubscription({
    subscriber: "inventory",
    handler: "consume-and-stock-production",
    eventName: "production.ProductionCompleted",
    // 原材料を消費し、製品ロットを入庫する。
    // 消費量はイベントに載っている (レシピは production の持ち物なので引かない)。
    handle: async (event, tx) => {
      await consumeAndStockProduction(unitOfWorkFor(tx), event.payload);
    },
  }),
  defineSubscription({
    subscriber: "inventory",
    handler: "ship-sold-products",
    eventName: "sales.SaleCompleted",
    // 製品を出庫する。製造完了より先に届いたら仮ロットを作ってマイナスで受ける。
    handle: async (event, tx) => {
      await shipSoldProducts(unitOfWorkFor(tx), event.payload);
    },
  }),
];
