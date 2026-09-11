/**
 * 商品一覧。
 *
 * catalog にとっての「クロワッサン」は名前・価格・アレルゲン表示を持つ**販売物**。
 * 在庫数も製造レシピもここには無い (別のコンテキストの持ち物)。
 *
 * catalog には一覧の API が無く、あるのは ID 引きなので、他のコンテキストに出てきた
 * `productId` を集めて 1 件ずつ引いている。他文脈が持つのが識別子だけであることの
 * 裏返しで、これが正しい向きの依存 (画面 → catalog の公開 API)。
 */
import { formatJpy } from "../format.ts";
import type { AsyncState } from "../use-async.ts";
import type { ProductMap } from "../use-products.ts";
import { AsyncBody, Section } from "./Section.tsx";

const ALLERGEN_LABELS: Record<string, string> = {
  wheat: "小麦",
  egg: "卵",
  milk: "乳",
  soba: "そば",
  peanut: "落花生",
  shrimp: "えび",
  crab: "かに",
  walnut: "くるみ",
};

export function ProductCatalog({ state }: { readonly state: AsyncState<ProductMap> }) {
  return (
    <Section
      title="商品"
      source="catalog"
      note="他のコンテキストに出てきた商品 ID を catalog に同期で問い合わせて引いている。販売停止しても行は消えない (過去の売上から参照されるため)。"
    >
      <AsyncBody state={state} isEmpty={(map) => map.size === 0} empty="商品がまだありません">
        {(map) => (
          <table>
            <thead>
              <tr>
                <th scope="col">商品</th>
                <th scope="col" className="num">
                  価格
                </th>
                <th scope="col">アレルゲン</th>
                <th scope="col">販売状態</th>
              </tr>
            </thead>
            <tbody>
              {[...map.values()].map((product) => (
                <tr key={product.productId}>
                  <th scope="row">{product.name}</th>
                  <td className="num">{formatJpy(product.priceJpy)}</td>
                  <td className="dim">
                    {product.allergens.length === 0
                      ? "—"
                      : product.allergens
                          .map((allergen) => ALLERGEN_LABELS[allergen] ?? allergen)
                          .join("・")}
                  </td>
                  <td>
                    {product.sellable ? (
                      <span className="badge badge-ok">販売中</span>
                    ) : (
                      <span className="badge">販売停止</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AsyncBody>
    </Section>
  );
}
