/**
 * catalog への同期の問い合わせ口の実装。
 *
 * 他モジュールへは相手の index.ts 経由でのみ依存できる (境界の強制 1/3)。
 * catalog の DB を直接見ることはできないし、見てはいけない。
 *
 * 状態を変えないので同期で呼んでよい。相手の状態を変える呼び出しは outbox 経由にする。
 */
import { catalog } from "../../catalog/index.ts";
import type { ProductPort, ProductPrice } from "../application/ports.ts";

export const catalogProducts: ProductPort = {
  async getProduct(productId: string): Promise<ProductPrice | null> {
    const product = await catalog.getProduct(productId);
    if (product === null) return null;
    // 受け取るのは価格と販売可否だけ。名前やアレルゲンを sales が持ち回らない。
    return { priceJpy: product.priceJpy, sellable: product.sellable };
  },
};
