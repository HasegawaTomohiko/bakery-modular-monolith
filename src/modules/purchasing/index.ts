/**
 * purchasing モジュールの公開 API (支援)。
 *
 * 責務: 仕入先、発注、入荷・検収
 *
 * ここでの「購買」は**原材料の仕入れ**を指す。お客さんへの販売は sales。
 *
 * 公開シグネチャは Phase 4a で確定した契約。実装 (Phase 4b) で変えないこと。
 */
import { defineSubscription, type Subscription } from "../../shared/event-bus.ts";
import type { Quantity } from "../../shared/events.ts";
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

export type SupplierId = string;
export type PurchaseOrderId = string;
export type GoodsReceiptId = string;
/** 原材料の識別子。inventory が採番したものを識別子としてだけ持つ。 */
export type IngredientId = string;

export type PurchaseOrderStatus = "placed" | "received" | "accepted" | "cancelled";

export type PurchaseOrderView = {
  readonly purchaseOrderId: PurchaseOrderId;
  readonly supplierId: SupplierId;
  readonly status: PurchaseOrderStatus;
  readonly orderedAt: string;
  readonly lines: readonly { readonly ingredientId: IngredientId; readonly quantity: Quantity }[];
};

/** 発注点割れから作られる提案。発注そのものは人が確定させる。 */
export type PurchaseSuggestionView = {
  readonly ingredientId: IngredientId;
  readonly suggestedQuantity: Quantity;
  readonly onHandAtDetection: Quantity;
  readonly createdAt: string;
};

export type RegisterSupplierInput = {
  readonly name: string;
  readonly leadTimeDays: number;
};

export type PlacePurchaseOrderInput = {
  readonly supplierId: SupplierId;
  readonly lines: readonly { readonly ingredientId: IngredientId; readonly quantity: Quantity }[];
};

/** 入荷。まだ検収していないので在庫にはならない。 */
export type ReceiveGoodsInput = {
  readonly purchaseOrderId: PurchaseOrderId;
  readonly receivedAt: string;
  readonly lines: readonly {
    readonly ingredientId: IngredientId;
    readonly quantity: Quantity;
    readonly lotCode: string;
    readonly bestBefore: string;
  }[];
};

/** 検収。ここで初めて `purchasing.GoodsReceiptAccepted` が出る。 */
export type AcceptGoodsReceiptInput = {
  readonly goodsReceiptId: GoodsReceiptId;
  readonly acceptedAt: string;
};

// ---------------------------------------------------------------------------
// 公開ユースケース
// ---------------------------------------------------------------------------

export const purchasing = {
  registerSupplier(input: RegisterSupplierInput): Promise<SupplierId> {
    return useCases.registerSupplier(deps, input);
  },

  placePurchaseOrder(input: PlacePurchaseOrderInput): Promise<PurchaseOrderId> {
    return useCases.placePurchaseOrder(deps, input);
  },

  /** 入荷。モノが届いただけなのでイベントは出ない。在庫になるのは検収後。 */
  receiveGoods(input: ReceiveGoodsInput): Promise<GoodsReceiptId> {
    return useCases.receiveGoods(deps, input);
  },

  /** 検収する。`purchasing.GoodsReceiptAccepted` を発行し、inventory が入庫する。 */
  async acceptGoodsReceipt(input: AcceptGoodsReceiptInput): Promise<void> {
    // 差異の内訳はユースケースが返すが、公開シグネチャは void で確定しているので捨てる。
    // 必要になったら参照モデル側で入荷明細から引き直せる。
    await useCases.acceptGoodsReceipt(deps, input);
  },

  getPurchaseOrder(purchaseOrderId: PurchaseOrderId): Promise<PurchaseOrderView | null> {
    return useCases.getPurchaseOrder(deps, purchaseOrderId);
  },

  /** 人が判断すべき提案だけ。発注済み・却下になったものは出ない。 */
  async listPurchaseSuggestions(): Promise<readonly PurchaseSuggestionView[]> {
    const suggestions = await useCases.listPurchaseSuggestions(deps);
    // 公開面には状態を出さない。一覧に載っている = 未対応、という契約なので。
    return suggestions.map((suggestion) => ({
      ingredientId: suggestion.ingredientId,
      suggestedQuantity: suggestion.suggestedQuantity,
      onHandAtDetection: suggestion.onHandAtDetection,
      createdAt: suggestion.createdAt,
    }));
  },
} as const;

// ---------------------------------------------------------------------------
// 購読
// ---------------------------------------------------------------------------

export const purchasingSubscriptions: readonly Subscription[] = [
  defineSubscription({
    subscriber: "purchasing",
    handler: "suggest-order-on-reorder-point",
    eventName: "inventory.ReorderPointBreached",
    // 発注提案を作る。自動発注はしない。仕入先ごとのリードタイムと最小ロットが
    // 絡むため、確定は人の判断に残す。
    //
    // event-bus が開いた inbox のトランザクションに相乗りする (tx をそのまま使う)。
    // 新しくトランザクションを開くと inbox の記録と処理が分かれて冪等性が壊れる。
    handle: async (event, tx) => {
      await useCases.suggestOrderOnReorderPoint(unitOfWorkFor(tx), event.payload);
    },
  }),
];
