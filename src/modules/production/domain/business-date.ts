/**
 * 営業日。
 *
 * パン屋は当日焼いて当日売り切る。したがって production の時間の単位は
 * 「営業日 (YYYY-MM-DD)」であって時刻ではない。契約でも賞味期限・製造日は
 * 日付のみ (isoDate) で運ぶことになっている (docs/conventions/events.md)。
 *
 * 販売実績はオフセット付きの時刻 (soldAt) で届くが、営業日はその**現地日付**を
 * そのまま採用する。「7:42 に売れた」の 7:42 は店の時計の時刻であり、
 * 文字列に含まれるオフセットが店の時間帯を表しているため、UTC に直してから
 * 日付を取ると日跨ぎで営業日がずれる。深夜営業のように「営業日の切り替えが
 * 0 時ではない」店を扱うようになったら、切り替え時刻を設定として持つ必要がある。
 */
import { ProductionValidationError } from "./errors.ts";

/** YYYY-MM-DD。 */
export type BusinessDate = string;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_DATE_PART = /^(\d{4}-\d{2}-\d{2})T/;

export function assertBusinessDate(value: string, label = "営業日"): BusinessDate {
  if (!DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ProductionValidationError(`${label} は YYYY-MM-DD 形式で指定してください: ${value}`);
  }
  return value;
}

/** オフセット付き時刻から営業日を取り出す。現地日付をそのまま使う (上のコメント参照)。 */
export function businessDateOf(isoDatetime: string): BusinessDate {
  const matched = DATETIME_DATE_PART.exec(isoDatetime);
  if (matched?.[1] === undefined) {
    throw new ProductionValidationError(`時刻の形式が不正です: ${isoDatetime}`);
  }
  return matched[1];
}

/** 日付の足し引き。UTC 正午を基準にして夏時間で 1 日ずれるのを避ける。 */
export function shiftBusinessDate(date: BusinessDate, days: number): BusinessDate {
  assertBusinessDate(date);
  const base = new Date(`${date}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** 0 = 日曜。曜日差 (土日は多い) を見るために使う。 */
export function weekdayOf(date: BusinessDate): number {
  assertBusinessDate(date);
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function isBefore(left: BusinessDate, right: BusinessDate): boolean {
  return left < right;
}

export function isOnOrAfter(left: BusinessDate, right: BusinessDate): boolean {
  return left >= right;
}
