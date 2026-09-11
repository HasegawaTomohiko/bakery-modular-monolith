/**
 * 数量の扱い。
 *
 * 契約 (shared/events.ts) の Quantity は `{ amount, unit }` で、単位は基本単位
 * (g / ml / piece) に正規化して運ぶ。production の中でも同じ形のまま扱い、
 * kg や「1袋」といった換算はこのモジュールに持ち込まない。
 *
 * 製品は個数 (piece)、原材料は質量/体積 (g / ml) で数える。混ざると
 * 「クロワッサン 60 個」と「強力粉 60g」の区別が付かなくなるので、
 * 受け取った時点で単位を検査する。
 */
import type { Quantity } from "../../../shared/events.ts";
import { ProductionValidationError } from "./errors.ts";

export type QuantityUnit = Quantity["unit"];

/**
 * 小数の丸め位置。g / ml は mg まで、piece は整数しか使わない。
 * 浮動小数の誤差 (0.1 + 0.2) がそのまま原材料の消費量として
 * inventory に流れないよう、計算のたびにここで丸める。
 */
const AMOUNT_SCALE = 3;

export function roundAmount(amount: number): number {
  const factor = 10 ** AMOUNT_SCALE;
  return Math.round(amount * factor) / factor;
}

export function quantity(amount: number, unit: QuantityUnit): Quantity {
  return { amount: roundAmount(amount), unit };
}

export function assertPositive(value: Quantity, label: string): void {
  if (!Number.isFinite(value.amount) || value.amount <= 0) {
    throw new ProductionValidationError(`${label} は正の数量である必要があります`);
  }
}

/** 製品の個数。1.5 個は焼けないので整数であることまで見る。 */
export function assertPieces(value: Quantity, label: string): void {
  if (value.unit !== "piece") {
    throw new ProductionValidationError(
      `${label} は個数 (piece) で指定してください (受け取った単位: ${value.unit})`,
    );
  }
  assertPositive(value, label);
  if (!Number.isInteger(value.amount)) {
    throw new ProductionValidationError(`${label} は整数である必要があります`);
  }
}

/** 原材料の分量。個数で数える原材料 (卵 2 個など) もあるので unit は限定しない。 */
export function assertIngredientAmount(value: Quantity, label: string): void {
  assertPositive(value, label);
}

export function scaleQuantity(value: Quantity, factor: number): Quantity {
  return quantity(value.amount * factor, value.unit);
}

export function addQuantity(left: Quantity, right: Quantity): Quantity {
  if (left.unit !== right.unit) {
    throw new ProductionValidationError(
      `単位の違う数量は足せません (${left.unit} と ${right.unit})`,
    );
  }
  return quantity(left.amount + right.amount, left.unit);
}
