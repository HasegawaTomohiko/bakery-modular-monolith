/**
 * CatalogStore の drizzle 実装。
 *
 * 接続は catalog 専用ロール (shared/db.ts)。他モジュールのスキーマには USAGE すら
 * 無いので、ここから境界をまたぐクエリを書いても実行時に権限エラーになる。
 *
 * ユースケースは `CatalogTransaction` しか見えないので、drizzle も pg も
 * このファイルの外に漏れない。
 */
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { productDelistedSchema } from "../../../shared/events.ts";
import { publishEvent } from "../../../shared/outbox.ts";
import type { Executor } from "../../../shared/tables.ts";
import type { CatalogStore, CatalogTransaction, StoredProduct } from "../application/store.ts";
import { parseAllergens } from "../domain/allergen.ts";
import type { DelistReason, PriceRecord, Product, ProductId } from "../domain/product.ts";
import { productPrices, products } from "./db/schema.ts";

type ProductRow = typeof products.$inferSelect;
type PriceRow = typeof productPrices.$inferSelect;

/** 保存されている理由文字列を契約の enum に戻す。契約外なら落とす。 */
function parseDelistReason(stored: string): DelistReason {
  return productDelistedSchema.shape.reason.parse(stored);
}

function toProduct(row: ProductRow): Product {
  return {
    productId: row.id,
    name: row.name,
    allergens: parseAllergens(row.allergens),
    sellable: row.sellable,
    delistedAt: row.delistedAt,
    delistReason: row.delistReason === null ? null : parseDelistReason(row.delistReason),
    registeredAt: row.registeredAt,
  };
}

function toPrice(row: PriceRow): PriceRecord {
  return { priceJpy: row.priceJpy, effectiveFrom: row.effectiveFrom };
}

function createTransaction(tx: Executor): CatalogTransaction {
  /** 商品 ID ごとの価格履歴をまとめて引く。件数分クエリを投げないため。 */
  const pricesByProduct = async (
    productIds: readonly ProductId[],
  ): Promise<Map<ProductId, PriceRecord[]>> => {
    const grouped = new Map<ProductId, PriceRecord[]>();
    if (productIds.length === 0) return grouped;

    const rows = await tx
      .select()
      .from(productPrices)
      .where(inArray(productPrices.productId, [...productIds]));

    for (const row of rows) {
      const list = grouped.get(row.productId) ?? [];
      list.push(toPrice(row));
      grouped.set(row.productId, list);
    }
    return grouped;
  };

  return {
    async insertProduct(product, initialPrice) {
      await tx.insert(products).values({
        id: product.productId,
        name: product.name,
        allergens: [...product.allergens],
        sellable: product.sellable,
        delistedAt: product.delistedAt,
        delistReason: product.delistReason,
        registeredAt: product.registeredAt,
      });
      await tx.insert(productPrices).values({
        productId: product.productId,
        priceJpy: initialPrice.priceJpy,
        effectiveFrom: initialPrice.effectiveFrom,
      });
    },

    async findProduct(productId) {
      const rows = await tx.select().from(products).where(eq(products.id, productId)).limit(1);
      const row = rows[0];
      if (row === undefined) return null;

      const prices = await pricesByProduct([row.id]);
      return { product: toProduct(row), prices: prices.get(row.id) ?? [] };
    },

    async listSellable() {
      const rows = await tx.select().from(products).where(eq(products.sellable, true));
      const prices = await pricesByProduct(rows.map((row) => row.id));

      return (
        rows
          .map(
            (row): StoredProduct => ({ product: toProduct(row), prices: prices.get(row.id) ?? [] }),
          )
          // 一覧の並びは名前順。登録順だと画面の並びが登録のたびに変わるため。
          .sort((a, b) => a.product.name.localeCompare(b.product.name, "ja"))
      );
    },

    async appendPrice(productId, price) {
      await tx
        .insert(productPrices)
        .values({
          productId,
          priceJpy: price.priceJpy,
          effectiveFrom: price.effectiveFrom,
        })
        // 同一時刻の改定は最後の指定を有効にする。主キー衝突で落とすと、
        // 単に「同じ瞬間に2回叩いた」だけで 500 になるため。
        .onConflictDoUpdate({
          target: [productPrices.productId, productPrices.effectiveFrom],
          set: { priceJpy: price.priceJpy },
        });
    },

    async markDelisted(productId, reason, delistedAt) {
      // sellable = true の行だけを対象にする。同時実行でも停止できるのは片方だけ。
      const updated = await tx
        .update(products)
        .set({ sellable: false, delistedAt, delistReason: reason })
        .where(and(eq(products.id, productId), eq(products.sellable, true)))
        .returning({ id: products.id });
      return updated.length > 0;
    },

    async publish(name, payload) {
      // 業務データと同じ tx。片方だけ成功することがない。
      await publishEvent(tx, "catalog", name, payload);
    },
  };
}

export function createCatalogStore(db: NodePgDatabase): CatalogStore {
  return {
    transaction(run) {
      return db.transaction((tx) => run(createTransaction(tx)));
    },
  };
}
