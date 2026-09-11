/**
 * 数量の扱い。
 *
 * 単位は shared/events.ts の契約どおり基本単位 (g / ml / piece) に正規化済みの前提。
 * ここで kg → g のような換算はしない。換算表を各モジュールが持つと必ずずれるため。
 *
 * 原材料は質量・体積で数えるので、発注 10kg に対して実測 9.8kg のような
 * 端数が日常的に出る。等値比較ではなく差分で扱う。
 */
import type { Quantity } from "../../../shared/events.ts";
import { invalid } from "./errors.ts";

/**
 * 浮動小数の丸め誤差を吸収する桁数。
 * g / ml は 0.001 (= 1mg / 1μL) まで見れば実務上足りる。
 */
const SCALE = 3;

export function roundAmount(amount: number): number {
  return Number(amount.toFixed(SCALE));
}

export function formatQuantity(quantity: Quantity): string {
  return `${roundAmount(quantity.amount)}${quantity.unit}`;
}

/** 単位が違う数量は足し引きできない。呼ぶ前に必ず通す。 */
export function assertSameUnit(left: Quantity, right: Quantity, context: string): void {
  if (left.unit !== right.unit) {
    throw invalid(`${context}: 単位が一致しません (${left.unit} と ${right.unit})`);
  }
}

/** 発注・入荷の数量は正であること。0 や負の行は業務上の意味がない。 */
export function assertPositive(quantity: Quantity, context: string): void {
  if (!(quantity.amount > 0)) {
    throw invalid(`${context}: 数量は正の値であること (${formatQuantity(quantity)})`);
  }
}

/** left - right。単位は呼び出し側で揃えておくこと。 */
export function subtract(left: Quantity, right: Quantity): Quantity {
  assertSameUnit(left, right, "数量の差");
  return { amount: roundAmount(left.amount - right.amount), unit: left.unit };
}

export function add(left: Quantity, right: Quantity): Quantity {
  assertSameUnit(left, right, "数量の和");
  return { amount: roundAmount(left.amount + right.amount), unit: left.unit };
}

export function isZero(quantity: Quantity): boolean {
  return roundAmount(quantity.amount) === 0;
}
