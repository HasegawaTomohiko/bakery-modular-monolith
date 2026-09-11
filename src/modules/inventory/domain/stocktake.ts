/**
 * 棚卸。
 *
 * 在庫数は棚卸で補正する近似値でしかない。粉は袋から出るときにこぼれるし、
 * 焼成中に落としたクロワッサンは誰も記録しない。試作に使った 200g も伝票に残らない。
 * イベントをどれだけ正確に処理しても、棚にある本当の数とは一致しない。
 *
 * したがって棚卸が**唯一の正攻法の補正手段**で、実地の数がそのまま新しい基準になる。
 * ただし「いくらズレていたか」を残さずに上書きすると、ズレが常態化しても誰も気づけない。
 * 差分を明細として記録する。
 */
import type { Quantity } from "../../../shared/events.ts";
import { subtract } from "./quantity.ts";

export type StocktakeTarget =
  | { readonly kind: "ingredient"; readonly ingredientId: string }
  | { readonly kind: "product_lot"; readonly lotCode: string };

export type StocktakeDiff = {
  readonly target: StocktakeTarget;
  /** 帳簿在庫 (棚卸前のシステム上の数)。 */
  readonly book: Quantity;
  /** 実地在庫 (数えた数)。これが新しい基準になる。 */
  readonly counted: Quantity;
  /** counted - book。負なら記録漏れの消費、正なら記録漏れの入庫。 */
  readonly diff: Quantity;
};

export function diffOf(target: StocktakeTarget, book: Quantity, counted: Quantity): StocktakeDiff {
  // 単位は帳簿側 (自スキーマの登録値) を正とする。
  const normalized: Quantity = { amount: counted.amount, unit: book.unit };
  return { target, book, counted: normalized, diff: subtract(normalized, book) };
}
