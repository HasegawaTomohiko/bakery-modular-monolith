/**
 * 在庫。
 *
 * **原材料と製品ロットを別の表にする。** 原材料は g/kg で日〜週単位の賞味期限を持ち、
 * 製品は個数で当日限り・売れ残りは廃棄になる。性質が違うので inventory の中でも
 * モデルが分かれており (atodekesu.md 3章)、画面でも 1 つの表に混ぜない。
 *
 * 在庫がマイナスなのはエラーではなくアラート。イベントの到着順で一時的に負になり得る
 * ことを許容する設計なので、止めずに「気づける」形で出す。
 */
import { formatDate, formatNumber, formatQuantity } from "../format.ts";
import type { IngredientStock, ProductLot, StockAlert } from "../queries.ts";
import type { AsyncState } from "../use-async.ts";
import { type ProductMap, productLabel } from "../use-products.ts";
import { AsyncBody, Section } from "./Section.tsx";

/**
 * アラートは種類ごとに指す対象が違う。製品在庫のマイナスが持つのはロット番号だけで
 * 商品 ID は無いので、商品名は出せない (無いものを埋めない)。
 */
function alertText(alert: StockAlert): string {
  switch (alert.kind) {
    case "negative_ingredient_stock":
      return `原材料 ${alert.ingredientId.slice(0, 8)}… の在庫が ${formatQuantity(alert.onHand)}`;
    case "negative_product_stock":
      return `ロット ${alert.lotCode} の在庫が ${formatQuantity(alert.onHand)}`;
    case "expired_ingredient":
      return `原材料 ${alert.ingredientId.slice(0, 8)}… が期限切れ (${alert.bestBefore})`;
    default:
      // 契約に無い種類が来ても画面は壊さない。
      return JSON.stringify(alert);
  }
}

export function IngredientPanel({ state }: { readonly state: AsyncState<IngredientStock[]> }) {
  return (
    <Section
      title="原材料在庫"
      source="inventory (g / ml)"
      note="発注点を下回ると inventory がイベントを出し、purchasing が発注提案を作る。"
    >
      <AsyncBody state={state} isEmpty={(rows) => rows.length === 0} empty="原材料がまだありません">
        {(rows) => (
          <table>
            <thead>
              <tr>
                <th scope="col">原材料</th>
                <th scope="col" className="num">
                  在庫
                </th>
                <th scope="col" className="num">
                  発注点
                </th>
                <th scope="col">最短の賞味期限</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                // 発注点割れは「切らす手前」の合図。赤ではなく注意色で出す。
                const low = row.onHand.amount <= row.reorderPoint.amount;
                return (
                  <tr key={row.ingredientId}>
                    <th scope="row">{row.name}</th>
                    <td className={`num${low ? " waste-warn" : ""}`}>
                      {formatQuantity(row.onHand)}
                      {low && <span className="badge">発注点割れ</span>}
                    </td>
                    <td className="num dim">{formatQuantity(row.reorderPoint)}</td>
                    <td>{formatDate(row.nearestBestBefore)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </AsyncBody>
    </Section>
  );
}

export function ProductLotPanel({
  state,
  products,
}: {
  readonly state: AsyncState<ProductLot[]>;
  readonly products: ProductMap | null;
}) {
  return (
    <Section
      title="製品ロット在庫"
      source="inventory (個数)"
      note="当日焼いて当日売り切る。閉店時に残っている数がそのまま廃棄ロスになる。"
    >
      <AsyncBody state={state} isEmpty={(rows) => rows.length === 0} empty="製品ロットはありません">
        {(rows) => (
          <table>
            <thead>
              <tr>
                <th scope="col">ロット</th>
                <th scope="col">商品</th>
                <th scope="col" className="num">
                  残り
                </th>
                <th scope="col">賞味期限</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.lotCode}>
                  <th scope="row">
                    <code>{row.lotCode}</code>
                  </th>
                  <td>{productLabel(products, row.productId)}</td>
                  <td className={`num${row.onHand.amount < 0 ? " waste-bad" : ""}`}>
                    {formatNumber(row.onHand.amount)} 個
                  </td>
                  <td>{row.bestBefore}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AsyncBody>
    </Section>
  );
}

export function AlertPanel({ state }: { readonly state: AsyncState<StockAlert[]> }) {
  return (
    <Section
      title="在庫アラート"
      source="inventory"
      note="在庫がマイナスなのはエラーではなくアラート。イベントの遅れか記録漏れかは人が判断し、正解は棚卸で決める。"
    >
      <AsyncBody state={state} isEmpty={(rows) => rows.length === 0} empty="アラートはありません">
        {(rows) => (
          <ul className="alerts">
            {rows.map((alert) => (
              <li key={JSON.stringify(alert)}>
                <span className="badge badge-alert">{alert.kind}</span>
                {alertText(alert)}
              </li>
            ))}
          </ul>
        )}
      </AsyncBody>
    </Section>
  );
}
