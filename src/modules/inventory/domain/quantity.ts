/**
 * 数量の扱い。
 *
 * 単位は shared/events.ts の契約どおり基本単位 (g / ml / piece) に正規化済みの前提。
 * ここで kg → g のような換算はしない。換算表を各モジュールが持つと必ずずれるため。
 *
 * 原材料は質量・体積なので端数が日常的に出る。製品は個数なので端数は出ない。
 * どちらも同じ丸め規則 (小数3桁) で扱い、比較は必ず丸めた値で行う。
 */
import type { Quantity } from "../../../shared/events.ts";
import { invalid } from "./errors.ts";

export type Unit = Quantity["unit"];

/**
 * 浮動小数の丸め誤差を吸収する桁数。
 * g / ml は 0.001 (= 1mg / 1μL) まで見れば実務上足りる。
 */
const SCALE = 3;

export function roundAmount(amount: number): number {
  return Number(amount.toFixed(SCALE));
}

export function quantityOf(amount: number, unit: Unit): Quantity {
  return { amount: roundAmount(amount), unit };
}

export function zero(unit: Unit): Quantity {
  return { amount: 0, unit };
}

export function formatQuantity(quantity: Quantity): string {
  return `${roundAmount(quantity.amount)}${quantity.unit}`;
}

export function add(left: Quantity, right: Quantity): Quantity {
  assertSameUnit(left, right, "数量の和");
  return quantityOf(left.amount + right.amount, left.unit);
}

export function subtract(left: Quantity, right: Quantity): Quantity {
  assertSameUnit(left, right, "数量の差");
  return quantityOf(left.amount - right.amount, left.unit);
}

export function isNegative(quantity: Quantity): boolean {
  return roundAmount(quantity.amount) < 0;
}

export function isZero(quantity: Quantity): boolean {
  return roundAmount(quantity.amount) === 0;
}

/** left < right か。発注点の判定に使うので「下回った」= 厳密に小さい。 */
export function isLessThan(left: Quantity, right: Quantity): boolean {
  assertSameUnit(left, right, "数量の比較");
  return roundAmount(left.amount) < roundAmount(right.amount);
}

export function minAmount(left: number, right: number): number {
  return roundAmount(Math.min(left, right));
}

/** 単位が違う数量は足し引きできない。公開ユースケースの入口で必ず通す。 */
export function assertSameUnit(left: Quantity, right: Quantity, context: string): void {
  if (left.unit !== right.unit) {
    throw invalid(`${context}: 単位が一致しません (${left.unit} と ${right.unit})`);
  }
}

export function assertPositive(quantity: Quantity, context: string): void {
  if (!(quantity.amount > 0)) {
    throw invalid(`${context}: 数量は正の値であること (${formatQuantity(quantity)})`);
  }
}

export function assertNonNegative(quantity: Quantity, context: string): void {
  if (!(quantity.amount >= 0)) {
    throw invalid(`${context}: 数量は 0 以上であること (${formatQuantity(quantity)})`);
  }
}

/**
 * 自分が知っている単位に合わせ直す。
 *
 * **購読ハンドラ専用。** イベントの単位が自分の登録値とずれていたら、
 * 数量だけを受け取って単位は自スキーマの登録値を正とする。
 * ここで例外を投げると worker が詰まる (errors.ts のコメント参照) ので、
 * 止めずに進めて「在庫は棚卸で補正する近似値」という前提に寄せる。
 */
export function coerceUnit(quantity: Quantity, unit: Unit): Quantity {
  return quantityOf(quantity.amount, unit);
}
