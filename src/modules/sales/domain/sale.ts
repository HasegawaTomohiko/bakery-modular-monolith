/**
 * 販売 (レシートの 1 枚)。
 *
 * sales から見た「クロワッサン」はレシートの 1 行でしかない。名前もアレルゲンも
 * 持たず、商品識別子とロット、売った個数、**その時の**単価だけを持つ。
 *
 * - `unitPriceJpy` は販売時点の価格を焼き付ける。catalog の現在価格を後から引くと、
 *   価格改定のたびに過去の売上が書き換わってしまうため。
 * - `lotCode` は inventory のロット識別子。sales は在庫を持たないので、
 *   どのロットを売ったかを伝えるだけで、出庫は inventory が行う (結果整合)。
 */
import type { EventPayload } from "../../../shared/events.ts";
import { businessDateOf } from "./business-date.ts";
import { invalidInput } from "./errors.ts";
import { toIsoInstant } from "./instant.ts";
import { pieces } from "./quantity.ts";

export type SaleChannel = EventPayload<"sales.SaleCompleted">["channel"];

/** 値付け前の明細。数量の検証だけ済んでいる状態。 */
export type SoldLine = {
  readonly productId: string;
  readonly lotCode: string;
  readonly pieces: number;
};

export type SaleLine = SoldLine & {
  readonly unitPriceJpy: number;
  readonly subtotalJpy: number;
};

export type Sale = {
  readonly saleId: string;
  readonly channel: SaleChannel;
  readonly soldAt: Date;
  readonly businessDate: string;
  /** 予約由来の販売だけ埋まる。予約は sales 内の識別子なので保持してよい。 */
  readonly reservationId: string | null;
  readonly totalJpy: number;
  readonly lines: readonly SaleLine[];
};

export type BuildSaleParams = {
  readonly saleId: string;
  readonly channel: SaleChannel;
  readonly soldAt: Date;
  readonly reservationId: string | null;
  readonly lines: readonly SoldLine[];
  /** 販売時点の価格。商品識別子から引く。 */
  readonly unitPriceOf: (productId: string) => number;
};

/** 明細に値付けして販売を組み立てる。金額の計算はここに閉じる。 */
export function buildSale(params: BuildSaleParams): Sale {
  if (params.lines.length === 0) {
    throw invalidInput("販売明細が空です");
  }

  const lines = params.lines.map((line) => {
    const unitPriceJpy = params.unitPriceOf(line.productId);
    return { ...line, unitPriceJpy, subtotalJpy: unitPriceJpy * line.pieces };
  });

  return {
    saleId: params.saleId,
    channel: params.channel,
    soldAt: params.soldAt,
    businessDate: businessDateOf(params.soldAt),
    reservationId: params.reservationId,
    totalJpy: lines.reduce((total, line) => total + line.subtotalJpy, 0),
    lines,
  };
}

/**
 * 販売確定イベントのペイロードに変換する。
 *
 * 載せるのは受け手 (inventory: 出庫 / production: 需要予測) が境界を越えずに
 * 処理を終えられる分だけ。顧客名や予約 ID のような sales の内部事情は載せない。
 */
export function toSaleCompletedPayload(sale: Sale): EventPayload<"sales.SaleCompleted"> {
  return {
    saleId: sale.saleId,
    channel: sale.channel,
    soldAt: toIsoInstant(sale.soldAt),
    lines: sale.lines.map((line) => ({
      productId: line.productId,
      lotCode: line.lotCode,
      quantity: pieces(line.pieces),
      unitPriceJpy: line.unitPriceJpy,
    })),
    totalJpy: sale.totalJpy,
  };
}
