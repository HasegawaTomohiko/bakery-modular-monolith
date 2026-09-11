/**
 * 発注・入荷・検収のドメイン。
 *
 * ここで一番大事なのは**入荷と検収を別の出来事として扱う**こと。
 *
 *   入荷 (received) — モノが届いた。数量も品質もまだ確認していない
 *   検収 (accepted) — 数量と品質を確認して受け入れた。ここで初めて在庫になる
 *
 * トラックから降ろした時点で在庫に足してしまうと、「伝票は 10kg だが実際は 9.8kg」
 * 「粉が湿っていて返品」といった現実が在庫に反映されない。だから在庫になるのは
 * 検収後で、`purchasing.GoodsReceiptAccepted` は検収時にしか出さない。
 *
 * DB も HTTP も知らない純粋なコード。
 */
import type { Quantity } from "../../../shared/events.ts";
import { conflict, invalid } from "./errors.ts";
import { assertPositive, formatQuantity, isZero, subtract } from "./quantity.ts";

export type SupplierId = string;
export type PurchaseOrderId = string;
export type GoodsReceiptId = string;
/** inventory が採番した識別子。purchasing は名前も在庫数も持たない。 */
export type IngredientId = string;

/**
 * 発注の状態。
 *
 * placed → received → accepted が正常系。cancelled は発注を取り消した場合。
 * received と accepted が分かれているのがこの文脈の肝 (上のコメント参照)。
 */
export type PurchaseOrderStatus = "placed" | "received" | "accepted" | "cancelled";

export type OrderLine = {
  readonly ingredientId: IngredientId;
  readonly quantity: Quantity;
};

export type ReceiptLine = OrderLine & {
  /** 仕入先のロット番号。トレーサビリティ用。 */
  readonly lotCode: string;
  /** 原材料は日〜週単位の賞味期限を持つ。 */
  readonly bestBefore: string;
};

export type PurchaseOrder = {
  readonly purchaseOrderId: PurchaseOrderId;
  readonly supplierId: SupplierId;
  readonly status: PurchaseOrderStatus;
  readonly orderedAt: string;
  readonly lines: readonly OrderLine[];
};

export type GoodsReceipt = {
  readonly goodsReceiptId: GoodsReceiptId;
  readonly purchaseOrderId: PurchaseOrderId;
  readonly receivedAt: string;
  /** null なら未検収。検収済みなら受け入れた時刻。 */
  readonly acceptedAt: string | null;
  readonly lines: readonly ReceiptLine[];
};

// ---------------------------------------------------------------------------
// 発注
// ---------------------------------------------------------------------------

/** 発注行の検証。同じ原材料を2行に分けて書かせない (数量の突合が曖昧になるため)。 */
export function assertValidOrderLines(lines: readonly OrderLine[]): void {
  if (lines.length === 0) {
    throw invalid("発注には1行以上の明細が必要です");
  }
  const seen = new Set<IngredientId>();
  for (const line of lines) {
    assertPositive(line.quantity, `発注明細 ${line.ingredientId}`);
    if (seen.has(line.ingredientId)) {
      throw invalid(`発注明細に同じ原材料が重複しています: ${line.ingredientId}`);
    }
    seen.add(line.ingredientId);
  }
}

// ---------------------------------------------------------------------------
// 入荷
// ---------------------------------------------------------------------------

/**
 * 入荷を受け付けられる状態か。
 *
 * 検収まで終わった発注に後から入荷をぶら下げることはできない。分納が必要なら
 * 発注を分けるのが業務の建て付け (1発注 = 1入荷)。
 */
export function assertCanReceive(order: PurchaseOrder): void {
  if (order.status === "cancelled") {
    throw conflict(`取り消された発注には入荷を登録できません: ${order.purchaseOrderId}`);
  }
  if (order.status !== "placed") {
    throw conflict(
      `発注 ${order.purchaseOrderId} は既に ${order.status} です。入荷を登録できるのは placed のときだけです`,
    );
  }
}

/**
 * 入荷明細の検証。
 *
 * 数量が発注と違うこと自体は**エラーにしない**。10kg 頼んで 9.8kg 届くのは
 * 日常であり、それを記録するのが入荷の役目だから。弾くのは「発注していない
 * 原材料が混じっている」という、突合そのものが成り立たないケースだけ。
 */
export function assertValidReceiptLines(order: PurchaseOrder, lines: readonly ReceiptLine[]): void {
  if (lines.length === 0) {
    throw invalid("入荷には1行以上の明細が必要です");
  }
  const ordered = new Map(order.lines.map((line) => [line.ingredientId, line]));
  const seen = new Set<IngredientId>();

  for (const line of lines) {
    assertPositive(line.quantity, `入荷明細 ${line.ingredientId}`);
    if (line.lotCode.trim() === "") {
      throw invalid(`入荷明細 ${line.ingredientId}: ロット番号は必須です`);
    }
    if (seen.has(line.ingredientId)) {
      throw invalid(`入荷明細に同じ原材料が重複しています: ${line.ingredientId}`);
    }
    seen.add(line.ingredientId);

    const orderLine = ordered.get(line.ingredientId);
    if (orderLine === undefined) {
      throw invalid(
        `発注 ${order.purchaseOrderId} に無い原材料が入荷明細にあります: ${line.ingredientId}`,
      );
    }
    // 単位まで違うと差異が計算できない。これは記録の誤りなので弾く。
    if (orderLine.quantity.unit !== line.quantity.unit) {
      throw invalid(
        `入荷明細 ${line.ingredientId}: 単位が発注と違います ` +
          `(発注 ${orderLine.quantity.unit} / 入荷 ${line.quantity.unit})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 数量の差異
// ---------------------------------------------------------------------------

/** 発注に対する実測の差。`difference` が負なら不足、正なら過納。 */
export type LineVariance = {
  readonly ingredientId: IngredientId;
  readonly ordered: Quantity;
  readonly received: Quantity;
  readonly difference: Quantity;
};

/**
 * 発注と入荷の差異を出す。
 *
 * 「発注 10kg に対して実際は 9.8kg」を可視化するためのもの。
 * 入荷されなかった行は received = 0 として並べる (欠品も差異のうち)。
 */
export function calculateVariances(
  order: PurchaseOrder,
  receiptLines: readonly ReceiptLine[],
): readonly LineVariance[] {
  const received = new Map(receiptLines.map((line) => [line.ingredientId, line.quantity]));

  return order.lines.map((orderLine) => {
    const actual = received.get(orderLine.ingredientId) ?? {
      amount: 0,
      unit: orderLine.quantity.unit,
    };
    return {
      ingredientId: orderLine.ingredientId,
      ordered: orderLine.quantity,
      received: actual,
      difference: subtract(actual, orderLine.quantity),
    };
  });
}

/** 差異のある行だけ。検収時に人が見るべき行を絞るために使う。 */
export function significantVariances(variances: readonly LineVariance[]): readonly LineVariance[] {
  return variances.filter((variance) => !isZero(variance.difference));
}

export function describeVariance(variance: LineVariance): string {
  const sign = variance.difference.amount > 0 ? "+" : "";
  return (
    `${variance.ingredientId}: 発注 ${formatQuantity(variance.ordered)} / ` +
    `入荷 ${formatQuantity(variance.received)} (${sign}${formatQuantity(variance.difference)})`
  );
}

// ---------------------------------------------------------------------------
// 検収
// ---------------------------------------------------------------------------

/**
 * 検収できる状態か。
 *
 * 二重検収を弾くのがここの主目的。検収は `purchasing.GoodsReceiptAccepted` を
 * 出す唯一の場所なので、ここが緩いと inventory が同じ入庫を2回することになる。
 */
export function assertCanAccept(receipt: GoodsReceipt): void {
  if (receipt.acceptedAt !== null) {
    throw conflict(`入荷 ${receipt.goodsReceiptId} は既に ${receipt.acceptedAt} に検収済みです`);
  }
  if (receipt.lines.length === 0) {
    throw invalid(`入荷 ${receipt.goodsReceiptId} に明細がありません`);
  }
}

/**
 * 検収後の発注ステータス。
 *
 * 検収した実数が全行 0 (= 全量返品) なら発注は満たされていないので placed に戻す、
 * といった分岐は今は持たない。1発注1入荷で、検収したら accepted。
 */
export function statusAfterAccept(): PurchaseOrderStatus {
  return "accepted";
}

export function statusAfterReceive(): PurchaseOrderStatus {
  return "received";
}
