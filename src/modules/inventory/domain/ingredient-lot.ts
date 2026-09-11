/**
 * 原材料のロットと払い出し規則。
 *
 * ロットを持つ理由は2つ。トレーサビリティ (どの仕入ロットを使ったか) と、
 * 賞味期限の管理。原材料は日〜週単位で期限が来るので、どのロットから使うかで
 * 廃棄量が変わる。
 */
import type { Quantity } from "../../../shared/events.ts";
import type { Unit } from "./quantity.ts";
import { minAmount, quantityOf, roundAmount } from "./quantity.ts";

export type IngredientLot = {
  readonly lotId: string;
  readonly ingredientId: string;
  /** 仕入先のロット番号。inventory が採番するものではない。 */
  readonly lotCode: string;
  /** 日付のみ。時刻を持たせると日跨ぎの解釈が実装ごとに割れる。 */
  readonly bestBefore: string;
  readonly remaining: Quantity;
  readonly receivedAt: string;
};

export type LotAllocation = {
  readonly lotId: string;
  readonly consumed: Quantity;
  /** 引き当て後の残量。 */
  readonly remaining: Quantity;
};

export type FefoResult = {
  readonly allocations: readonly LotAllocation[];
  /**
   * ロットで裏付けられなかった不足分。
   *
   * 0 でないのは「記録に無いものを消費した」状態で、異常だが処理は止めない。
   * 帳簿在庫 (Ingredient.onHand) 側はこの分もマイナスに振れ、アラートになる。
   */
  readonly shortfall: Quantity;
};

/**
 * FEFO (First Expired, First Out) で払い出す。
 *
 * 先入先出 (FIFO) ではなく**賞味期限の早い順**にするのは、原材料の廃棄が
 * 期限切れで発生するため。後から入った粉でも期限が先に来るならそちらから使う方が
 * 廃棄が減る。同じ期限のロットは先に入ったものから使う (古い順)。
 *
 * 在庫が足りなくてもここでは例外にしない。結果整合なので、製造完了が入荷検収より
 * 先に届くことがある。足りない分は `shortfall` として返し、呼び出し側がアラートに回す。
 */
export function allocateFefo(lots: readonly IngredientLot[], demand: Quantity): FefoResult {
  const unit: Unit = demand.unit;
  let rest = roundAmount(demand.amount);
  const allocations: LotAllocation[] = [];

  const ordered = [...lots].sort(
    (left, right) =>
      left.bestBefore.localeCompare(right.bestBefore) ||
      left.receivedAt.localeCompare(right.receivedAt) ||
      left.lotId.localeCompare(right.lotId),
  );

  for (const lot of ordered) {
    if (rest <= 0) break;
    const available = roundAmount(lot.remaining.amount);
    if (available <= 0) continue;
    const consumed = minAmount(available, rest);
    allocations.push({
      lotId: lot.lotId,
      consumed: quantityOf(consumed, unit),
      remaining: quantityOf(available - consumed, lot.remaining.unit),
    });
    rest = roundAmount(rest - consumed);
  }

  return { allocations, shortfall: quantityOf(Math.max(rest, 0), unit) };
}

/** 賞味期限が最も早いロット (残量があるもの)。表示と期限切れアラートに使う。 */
export function nearestBestBefore(lots: readonly IngredientLot[]): string | null {
  const dates = lots
    .filter((lot) => roundAmount(lot.remaining.amount) > 0)
    .map((lot) => lot.bestBefore)
    .sort();
  return dates[0] ?? null;
}

/** `asOf` (当日) より前に期限が切れていて、まだ残量があるロット。 */
export function expiredLots(
  lots: readonly IngredientLot[],
  asOf: string,
): readonly IngredientLot[] {
  return lots.filter(
    (lot) => roundAmount(lot.remaining.amount) > 0 && lot.bestBefore.localeCompare(asOf) < 0,
  );
}
