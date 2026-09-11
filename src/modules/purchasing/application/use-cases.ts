/**
 * purchasing のユースケース。
 *
 * ここがトランザクション境界。業務データの書き込みと `publish()` を同じ
 * `UnitOfWork` の中で行うので、片方だけ成功することがない (境界の強制 3/3)。
 *
 * 他モジュールを同期で呼ぶところは今のところ無い。`ingredientId` は inventory が
 * 採番した識別子をそのまま持つだけで、原材料の名前も在庫数も purchasing は持たない。
 * 表示に必要なら inventory の公開ユースケースに問い合わせるが、それは呼び出し側
 * (画面や参照モデル) の仕事で、purchasing のテーブルには入れない。
 */
import type { EventPayload } from "../../../shared/events.ts";
import { invalid, notFound } from "../domain/errors.ts";
import {
  assertCanAccept,
  assertCanReceive,
  assertValidOrderLines,
  assertValidReceiptLines,
  calculateVariances,
  type GoodsReceiptId,
  type PurchaseOrder,
  type PurchaseOrderId,
  type ReceiptLine,
  type SupplierId,
  significantVariances,
  statusAfterAccept,
  statusAfterReceive,
} from "../domain/purchase-order.ts";
import type { PurchaseSuggestion } from "../domain/suggestion.ts";
import type { PurchasingDeps, UnitOfWork } from "./ports.ts";

// ---------------------------------------------------------------------------
// 仕入先
// ---------------------------------------------------------------------------

export type RegisterSupplierInput = {
  readonly name: string;
  readonly leadTimeDays: number;
};

export async function registerSupplier(
  deps: PurchasingDeps,
  input: RegisterSupplierInput,
): Promise<SupplierId> {
  const name = input.name.trim();
  if (name === "") {
    throw invalid("仕入先の名前は必須です");
  }
  // リードタイムは発注提案を人が判断するときの材料になる。負の日数は入力ミス。
  if (!Number.isInteger(input.leadTimeDays) || input.leadTimeDays < 0) {
    throw invalid(`リードタイムは 0 以上の整数であること: ${input.leadTimeDays}`);
  }

  return deps.transaction((uow) =>
    uow.repo.insertSupplier({ name, leadTimeDays: input.leadTimeDays }),
  );
}

// ---------------------------------------------------------------------------
// 発注
// ---------------------------------------------------------------------------

export type PlacePurchaseOrderInput = {
  readonly supplierId: SupplierId;
  readonly lines: PurchaseOrder["lines"];
};

/**
 * 発注する。
 *
 * 発注時点ではイベントを出さない。inventory が知りたいのは「実際に入ってきた量」で
 * あって「頼んだ量」ではないため。在庫が動くのは検収のときだけ。
 */
export async function placePurchaseOrder(
  deps: PurchasingDeps,
  input: PlacePurchaseOrderInput,
): Promise<PurchaseOrderId> {
  assertValidOrderLines(input.lines);
  const orderedAt = deps.now();

  return deps.transaction(async (uow) => {
    const supplier = await uow.repo.findSupplier(input.supplierId);
    if (supplier === null) {
      throw notFound(`仕入先が見つかりません: ${input.supplierId}`);
    }

    const purchaseOrderId = await uow.repo.insertPurchaseOrder({
      supplierId: input.supplierId,
      orderedAt,
      lines: input.lines,
    });

    // この発注で手当てされた原材料の提案を「発注済み」にする。
    // 人が提案を見て発注したのなら、その提案は一覧から消えるべきなので。
    await uow.repo.markSuggestionsOrdered(
      input.lines.map((line) => line.ingredientId),
      purchaseOrderId,
    );

    return purchaseOrderId;
  });
}

export async function getPurchaseOrder(
  deps: PurchasingDeps,
  purchaseOrderId: PurchaseOrderId,
): Promise<PurchaseOrder | null> {
  return deps.transaction((uow) => uow.repo.findPurchaseOrder(purchaseOrderId));
}

// ---------------------------------------------------------------------------
// 入荷
// ---------------------------------------------------------------------------

export type ReceiveGoodsInput = {
  readonly purchaseOrderId: PurchaseOrderId;
  readonly receivedAt: string;
  readonly lines: readonly ReceiptLine[];
};

/**
 * 入荷を登録する。**イベントは出さない。**
 *
 * モノが届いただけでは在庫にならない。数量と品質を確認する検収を通って初めて
 * `purchasing.GoodsReceiptAccepted` が出る。ここでイベントを出してしまうと、
 * 検品前の 9.8kg や湿った粉がそのまま在庫に載る。
 *
 * 数量が発注と違っていても弾かない。届いた実数をそのまま記録するのが入荷の役目。
 */
export async function receiveGoods(
  deps: PurchasingDeps,
  input: ReceiveGoodsInput,
): Promise<GoodsReceiptId> {
  const receivedAt = parseInstant(input.receivedAt, "receivedAt");

  return deps.transaction(async (uow) => {
    const order = await uow.repo.findPurchaseOrder(input.purchaseOrderId);
    if (order === null) {
      throw notFound(`発注が見つかりません: ${input.purchaseOrderId}`);
    }
    assertCanReceive(order);
    assertValidReceiptLines(order, input.lines);

    const goodsReceiptId = await uow.repo.insertGoodsReceipt({
      purchaseOrderId: input.purchaseOrderId,
      receivedAt,
      lines: input.lines,
    });
    await uow.repo.updatePurchaseOrderStatus(input.purchaseOrderId, statusAfterReceive());

    return goodsReceiptId;
  });
}

// ---------------------------------------------------------------------------
// 検収
// ---------------------------------------------------------------------------

export type AcceptGoodsReceiptInput = {
  readonly goodsReceiptId: GoodsReceiptId;
  readonly acceptedAt: string;
};

export type AcceptGoodsReceiptResult = {
  readonly goodsReceiptId: GoodsReceiptId;
  readonly purchaseOrderId: PurchaseOrderId;
  /** 発注と実測の差異のうち、0 でなかった行。人が後から追えるように返す。 */
  readonly variances: readonly string[];
};

/**
 * 検収する。ここでだけ `purchasing.GoodsReceiptAccepted` が出る。
 *
 * イベントに載せるのは**検収した実数**。発注した 10kg ではなく、実際に受け入れた
 * 9.8kg を渡す。inventory は届いた数量を知る手段がこれしかないため。
 */
export async function acceptGoodsReceipt(
  deps: PurchasingDeps,
  input: AcceptGoodsReceiptInput,
): Promise<AcceptGoodsReceiptResult> {
  const acceptedAt = parseInstant(input.acceptedAt, "acceptedAt");

  return deps.transaction(async (uow) => {
    const receipt = await uow.repo.findGoodsReceipt(input.goodsReceiptId);
    if (receipt === null) {
      throw notFound(`入荷が見つかりません: ${input.goodsReceiptId}`);
    }
    assertCanAccept(receipt);

    const order = await uow.repo.findPurchaseOrder(receipt.purchaseOrderId);
    if (order === null) {
      // 発注が消えている = データの不整合。ここまで来たら業務判断では直せない。
      throw notFound(`入荷 ${receipt.goodsReceiptId} の発注が見つかりません`);
    }

    await uow.repo.markGoodsReceiptAccepted(receipt.goodsReceiptId, acceptedAt);
    await uow.repo.updatePurchaseOrderStatus(order.purchaseOrderId, statusAfterAccept());

    await publishAccepted(uow, order, receipt.goodsReceiptId, acceptedAt, receipt.lines);

    const variances = significantVariances(calculateVariances(order, receipt.lines));
    return {
      goodsReceiptId: receipt.goodsReceiptId,
      purchaseOrderId: order.purchaseOrderId,
      variances: variances.map((variance) => variance.ingredientId),
    };
  });
}

async function publishAccepted(
  uow: UnitOfWork,
  order: PurchaseOrder,
  goodsReceiptId: GoodsReceiptId,
  acceptedAt: Date,
  lines: readonly ReceiptLine[],
): Promise<void> {
  const payload: EventPayload<"purchasing.GoodsReceiptAccepted"> = {
    goodsReceiptId,
    purchaseOrderId: order.purchaseOrderId,
    supplierId: order.supplierId,
    acceptedAt: acceptedAt.toISOString(),
    // 検収した実数をそのまま載せる。発注数量ではない。
    lines: lines.map((line) => ({
      ingredientId: line.ingredientId,
      quantity: line.quantity,
      lotCode: line.lotCode,
      bestBefore: line.bestBefore,
    })),
  };
  await uow.publish("purchasing.GoodsReceiptAccepted", payload);
}

// ---------------------------------------------------------------------------
// 発注提案
// ---------------------------------------------------------------------------

/**
 * 発注点割れから提案を作る。`inventory.ReorderPointBreached` の購読ハンドラ本体。
 *
 * 自動発注はしない。仕入先ごとのリードタイムと最小ロットが絡むため、確定は人に残す。
 * 同じ原材料に未対応の提案が既にあれば作らない (重複提案は一覧の邪魔になる)。
 */
export async function suggestOrderOnReorderPoint(
  uow: UnitOfWork,
  payload: EventPayload<"inventory.ReorderPointBreached">,
): Promise<string | null> {
  return uow.repo.insertSuggestionIfNoneOpen({
    ingredientId: payload.ingredientId,
    suggestedQuantity: payload.suggestedOrderQuantity,
    onHandAtDetection: payload.onHand,
    createdAt: new Date(payload.detectedAt),
  });
}

/** 人が判断すべき提案の一覧。発注済み・却下は出さない。 */
export async function listPurchaseSuggestions(
  deps: PurchasingDeps,
): Promise<readonly PurchaseSuggestion[]> {
  return deps.transaction((uow) => uow.repo.listSuggestions("open"));
}

// ---------------------------------------------------------------------------

function parseInstant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw invalid(`${field} が日時として読めません: ${value}`);
  }
  return parsed;
}
