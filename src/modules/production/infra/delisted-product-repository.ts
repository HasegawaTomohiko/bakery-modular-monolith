/**
 * 販売停止になった商品。catalog.ProductDelisted の購読で書き込む。
 *
 * 商品の名前も価格も持たない。イベントで運ばれるのは「状態が変わった」という
 * 事実だけで、内容が要るなら catalog.getProduct() に同期で問い合わせる。
 */
import { inArray } from "drizzle-orm";
import type { Executor } from "../../../shared/tables.ts";
import type { DelistedProduct, DelistedProductRepository } from "../application/ports.ts";
import { delistedProducts } from "./db/schema.ts";

export const delistedProductRepository: DelistedProductRepository = {
  async markDelisted(tx: Executor, product: DelistedProduct): Promise<void> {
    await tx
      .insert(delistedProducts)
      .values({
        productId: product.productId,
        delistedAt: new Date(product.delistedAt),
        reason: product.reason,
      })
      // 同じ商品が再度停止されることはある (季節商品を戻して、また下げる)。
      // 最後の停止だけを持てば「以降の計画から外す」判断には足りる。
      .onConflictDoUpdate({
        target: delistedProducts.productId,
        set: { delistedAt: new Date(product.delistedAt), reason: product.reason },
      });
  },

  async filterDelisted(tx: Executor, productIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (productIds.length === 0) return new Set();

    const rows = await tx
      .select({ productId: delistedProducts.productId })
      .from(delistedProducts)
      .where(inArray(delistedProducts.productId, [...productIds]));

    return new Set(rows.map((row) => row.productId));
  },
};
