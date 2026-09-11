/**
 * 今日のサマリ。この画面の主役。
 *
 * パン屋のコアドメインは「今日何を何個焼くか」で、売上と廃棄ロスを分けるのがそれ。
 * したがって**売れ残り (= 当日限りなので廃棄ロス) が一目で分かること**を最優先に組む。
 * 製造は production、販売と売上は sales、ロットは inventory の持ち物だが、
 * この表はそれらを JOIN して作ったものではなく、イベントから組み立てた参照モデル
 * (`/dashboard/daily/:businessDate`) を 1 回読んだ結果。
 */

import { formatJpy, formatNumber } from "../format.ts";
import type { DailyDashboard, DailyProductSummary } from "../queries.ts";
import type { AsyncState } from "../use-async.ts";
import { type ProductMap, productLabel } from "../use-products.ts";
import { AsyncBody, Section } from "./Section.tsx";

/** 廃棄ロス率の重さ。数字の色と棒の色を揃えて、目で拾えるようにする。 */
function wasteLevel(produced: number, leftover: number): "none" | "warn" | "bad" {
  if (leftover <= 0) return "none";
  if (produced <= 0) return "bad";
  return leftover / produced >= 0.15 ? "bad" : "warn";
}

function Tile({
  label,
  value,
  unit,
  level,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly level?: "none" | "warn" | "bad";
  readonly hint?: string;
}) {
  return (
    <div className={`tile${level !== undefined ? ` tile-${level}` : ""}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">
        {value}
        {unit !== undefined && <span className="tile-unit">{unit}</span>}
      </span>
      {hint !== undefined && <span className="tile-hint">{hint}</span>}
    </div>
  );
}

function ProductRow({
  row,
  products,
  maxLeftover,
}: {
  readonly row: DailyProductSummary;
  readonly products: ProductMap | null;
  readonly maxLeftover: number;
}) {
  const level = wasteLevel(row.producedPieces, row.leftoverPieces);
  const rate = row.producedPieces > 0 ? row.leftoverPieces / row.producedPieces : 0;
  // 棒の長さは「その日いちばん余った商品」を基準にする。絶対数の大小が目で分かる。
  const width = maxLeftover > 0 ? Math.round((row.leftoverPieces / maxLeftover) * 100) : 0;

  return (
    <tr>
      <th scope="row">
        {productLabel(products, row.productId)}
        {row.delisted && (
          <span className="badge" title={row.delistReason ?? undefined}>
            販売停止
          </span>
        )}
      </th>
      <td className="num">{formatNumber(row.producedPieces)}</td>
      <td className="num">{formatNumber(row.soldPieces)}</td>
      <td className={`num waste waste-${level}`}>
        <span className="waste-number">{formatNumber(row.leftoverPieces)}</span>
        <span className="waste-bar" style={{ width: `${width}%` }} />
      </td>
      <td className={`num waste-${level}`}>
        {row.producedPieces > 0 ? `${(rate * 100).toFixed(0)}%` : "—"}
      </td>
      <td className="num">{formatJpy(row.salesJpy)}</td>
    </tr>
  );
}

export function DailySummary({
  state,
  products,
}: {
  readonly state: AsyncState<DailyDashboard>;
  readonly products: ProductMap | null;
}) {
  return (
    <Section
      title="今日のサマリ"
      source="参照モデル (/dashboard)"
      note="製造 − 販売 = 売れ残り。当日限りの商品なので、売れ残りはそのまま廃棄ロスになる。イベントから組み立てた参照モデルを読んでいる (コンテキストをまたぐ JOIN はしない)。"
    >
      <AsyncBody state={state}>
        {(dashboard) => {
          const maxLeftover = dashboard.products.reduce(
            (max, row) => Math.max(max, row.leftoverPieces),
            0,
          );
          const totals = dashboard.totals;
          const level = wasteLevel(totals.producedPieces, totals.leftoverPieces);
          // 余っている順。減らすべきものが上に来る。
          const rows = [...dashboard.products].sort(
            (a, b) => b.leftoverPieces - a.leftoverPieces || b.producedPieces - a.producedPieces,
          );

          return (
            <>
              <div className="tiles">
                <Tile label="売上" value={formatJpy(totals.salesJpy)} />
                <Tile label="製造" value={formatNumber(totals.producedPieces)} unit="個" />
                <Tile label="販売" value={formatNumber(totals.soldPieces)} unit="個" />
                <Tile
                  label="売れ残り (廃棄ロス)"
                  value={formatNumber(totals.leftoverPieces)}
                  unit="個"
                  level={level}
                  hint={`廃棄ロス率 ${totals.wasteRatePercent.toFixed(1)}%`}
                />
              </div>

              {rows.length === 0 ? (
                <p className="status">
                  この営業日のイベントはまだ届いていません。製造・販売を記録すると、worker
                  が配信した後にここへ現れます (結果整合)。
                </p>
              ) : (
                <table>
                  <caption>商品別</caption>
                  <thead>
                    <tr>
                      <th scope="col">商品</th>
                      <th scope="col" className="num">
                        製造
                      </th>
                      <th scope="col" className="num">
                        販売
                      </th>
                      <th scope="col" className="num">
                        売れ残り
                      </th>
                      <th scope="col" className="num">
                        ロス率
                      </th>
                      <th scope="col" className="num">
                        売上
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <ProductRow
                        key={row.productId}
                        row={row}
                        products={products}
                        maxLeftover={maxLeftover}
                      />
                    ))}
                  </tbody>
                </table>
              )}

              {dashboard.lots.length > 0 && (
                <table>
                  <caption>ロット別 (どのロットが余ったか)</caption>
                  <thead>
                    <tr>
                      <th scope="col">ロット</th>
                      <th scope="col">商品</th>
                      <th scope="col">賞味期限</th>
                      <th scope="col" className="num">
                        製造
                      </th>
                      <th scope="col" className="num">
                        販売
                      </th>
                      <th scope="col" className="num">
                        売れ残り
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.lots.map((lot) => (
                      <tr key={lot.lotCode}>
                        <th scope="row">
                          <code>{lot.lotCode}</code>
                        </th>
                        <td>{productLabel(products, lot.productId)}</td>
                        <td>{lot.bestBefore ?? "—"}</td>
                        <td className="num">{formatNumber(lot.producedPieces)}</td>
                        <td className="num">{formatNumber(lot.soldPieces)}</td>
                        <td
                          className={`num waste-${wasteLevel(lot.producedPieces, lot.leftoverPieces)}`}
                        >
                          {formatNumber(lot.leftoverPieces)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          );
        }}
      </AsyncBody>
    </Section>
  );
}
