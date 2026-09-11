/**
 * 商品名の解決。
 *
 * 他のコンテキスト (在庫・売上・参照モデル) が返すのは `productId` だけ。
 * 名前や価格は catalog の持ち物なので、**識別子で catalog に問い合わせて**引く。
 * これは境界を越える JOIN ではなく、公開 API への同期の問い合わせ。
 */
import { useCallback } from "react";
import { fetchProduct, type Product } from "./queries.ts";
import { type AsyncState, useAsync } from "./use-async.ts";

export type ProductMap = ReadonlyMap<string, Product>;

export function useProducts(
  productIds: readonly string[],
  intervalMs: number,
): AsyncState<ProductMap> {
  // 同じ商品が複数の文脈から出てくるので、重複は落としてから引く。
  // 文字列にしておくと、中身が同じなら load が作り直されない (= 取り直さない)。
  const key = [...new Set(productIds)].sort().join(",");

  const load = useCallback(
    async (signal: AbortSignal): Promise<ProductMap> => {
      const ids = key.length === 0 ? [] : key.split(",");
      const found = await Promise.all(ids.map((id) => fetchProduct(id, signal)));
      const map = new Map<string, Product>();
      ids.forEach((id, index) => {
        const product = found[index];
        if (product != null) map.set(id, product);
      });
      return map;
    },
    [key],
  );

  return useAsync(load, intervalMs);
}

/** 引けなかった商品は識別子の頭だけ出す。名前が無いことを嘘で埋めない。 */
export function productLabel(products: ProductMap | null, productId: string): string {
  return products?.get(productId)?.name ?? `${productId.slice(0, 8)}…`;
}
