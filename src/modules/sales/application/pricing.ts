/**
 * 販売時点の価格を catalog から引く。
 *
 * 価格は catalog の持ち物なので、sales は識別子で同期に問い合わせて**その時の値**を
 * 受け取り、販売レコードに焼き付ける。catalog の現在価格を後から引く設計にすると、
 * 価格改定のたびに過去の売上が変わってしまう。
 *
 * トランザクションの外で呼ぶこと。他モジュールへの問い合わせの間、
 * 自分のトランザクションを開けたままにしないため。
 */
import { SalesError } from "../domain/errors.ts";
import type { ProductPort } from "./ports.ts";

export type PriceLookupOptions = {
  /** 販売停止中の商品を弾くかどうか。新規の販売・予約受付では true。 */
  readonly requireSellable: boolean;
};

export async function fetchUnitPrices(
  products: ProductPort,
  productIds: readonly string[],
  options: PriceLookupOptions,
): Promise<ReadonlyMap<string, number>> {
  const prices = new Map<string, number>();
  // 同じ商品が複数明細にあっても問い合わせは 1 回でよい。
  for (const productId of new Set(productIds)) {
    const product = await products.getProduct(productId);
    if (product === null) {
      throw new SalesError("product_not_found", `商品 ${productId} は catalog にありません`);
    }
    if (options.requireSellable && !product.sellable) {
      throw new SalesError("product_not_sellable", `商品 ${productId} は販売停止中です`);
    }
    prices.set(productId, product.priceJpy);
  }
  return prices;
}

/** 引けなかったら例外。`buildSale` に渡す関数の形にする。 */
export function unitPriceOf(prices: ReadonlyMap<string, number>): (productId: string) => number {
  return (productId) => {
    const price = prices.get(productId);
    if (price === undefined) {
      throw new SalesError("product_not_found", `商品 ${productId} の価格を取得できていません`);
    }
    return price;
  };
}
