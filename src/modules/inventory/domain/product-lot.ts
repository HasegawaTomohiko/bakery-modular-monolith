/**
 * 製品ロットのドメイン。
 *
 * **原材料在庫 (ingredient.ts) とは別のモデル。**
 * ここでの「クロワッサン」は「今朝焼いた24個」というロットであり、
 * catalog の販売物 (名前・価格・アレルゲン) とも production のレシピとも別のもの。
 *
 * | | 原材料 | 製品 |
 * |---|---|---|
 * | 単位 | g / ml | piece |
 * | 賞味期限 | 日〜週 | 当日限り |
 * | 廃棄 | 期限切れ | 売れ残りで毎日 |
 * | ロット | 仕入先のロット番号 | production が付けたロットコード |
 * | 発注点 | ある | ない (製造計画が決める) |
 */
import type { Quantity } from "../../../shared/events.ts";
import type { Unit } from "./quantity.ts";
import { subtract } from "./quantity.ts";

/** 製品は個数で数える。1個の半分は売らない。 */
export const PRODUCT_UNIT: Unit = "piece";

export type ProductLot = {
  /** production が付けたロットコード。inventory は採番しない (他文脈の識別子)。 */
  readonly lotCode: string;
  /** catalog の商品識別子。名前も価格もここには持たない。 */
  readonly productId: string;
  readonly onHand: Quantity;
  readonly bestBefore: string;
  readonly producedAt: string;
  /**
   * 製造完了より先に販売確定が届いたときに作られた仮のロットか。
   *
   * 結果整合なのでこの順序は普通に起こる。出庫を捨てるとレジの記録と在庫が
   * 食い違うので、ロットを仮に作ってマイナスで受け止め、後から製造完了が
   * 届いた時点で本物の値 (製造日・賞味期限) に上書きする。
   */
  readonly provisional: boolean;
};

/**
 * 出庫する。**在庫が足りなくてもマイナスを許容する。**
 *
 * 例外にして処理を止めると、イベントが永久に再送されて worker が詰まる。
 * マイナスは listStockAlerts のアラートとして人に見せ、棚卸で補正する。
 */
export function ship(lot: ProductLot, quantity: Quantity): Quantity {
  return subtract(lot.onHand, { amount: quantity.amount, unit: lot.onHand.unit });
}
