/**
 * 店頭販売を記録する。
 *
 * 手順は 2 段階に分かれる。
 *   1. トランザクションの外で catalog に価格を問い合わせる (同期の問い合わせ)
 *   2. トランザクションの中で販売を書き、同じトランザクションで販売確定イベントを積む
 *
 * sales は在庫を持たない。どのロットを売ったかをイベントに載せるだけで、
 * 出庫は inventory が行う (結果整合)。ここで inventory のユースケースを呼んではいけない。
 */
import { SalesError } from "../domain/errors.ts";
import { parseInstant } from "../domain/instant.ts";
import { toPieces } from "../domain/quantity.ts";
import { buildSale, type SoldLine, toSaleCompletedPayload } from "../domain/sale.ts";
import type { RecordSaleInput, SaleLineInput } from "./inputs.ts";
import type { SalesDeps, SalesTx } from "./ports.ts";
import { fetchUnitPrices, unitPriceOf } from "./pricing.ts";

/** 参照コピー (catalog.ProductDelisted の購読で更新される) を見て販売停止を弾く。 */
export async function assertSellable(tx: SalesTx, productIds: readonly string[]): Promise<void> {
  const unsellable = await tx.findUnsellableProducts(productIds);
  const first = unsellable[0];
  if (first !== undefined) {
    throw new SalesError("product_not_sellable", `商品 ${first} は販売停止中です`);
  }
}

/** 明細の数量を個数に落とす。単位違いはここで落ちる。 */
export function toSoldLines(lines: readonly SaleLineInput[]): readonly SoldLine[] {
  return lines.map((line, index) => ({
    productId: line.productId,
    lotCode: line.lotCode,
    pieces: toPieces(line.quantity, `lines[${index}].quantity`),
  }));
}

export async function recordSale(deps: SalesDeps, input: RecordSaleInput): Promise<string> {
  const soldAt = parseInstant(input.soldAt, "soldAt");
  const lines = toSoldLines(input.lines);
  const productIds = lines.map((line) => line.productId);

  // 販売時点の価格。ここで引いた値を焼き付けるので、後から catalog の価格が変わっても
  // 過去の売上は動かない。
  const prices = await fetchUnitPrices(deps.products, productIds, { requireSellable: true });

  return deps.uow.run(async (tx) => {
    // catalog への問い合わせと二重に見えるが、こちらは sales が持つ参照コピー。
    // catalog が一時的に応答しなくても販売停止を守れるようにしておく。
    await assertSellable(tx, productIds);

    const sale = buildSale({
      saleId: deps.newId(),
      channel: "storefront",
      soldAt,
      reservationId: null,
      lines,
      unitPriceOf: unitPriceOf(prices),
    });

    await tx.insertSale(sale);
    // 業務データと同じトランザクションで積む。片方だけ成功することがない。
    await tx.publishSaleCompleted(toSaleCompletedPayload(sale));
    return sale.saleId;
  });
}
