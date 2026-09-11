/**
 * 日付・時刻のパース。
 *
 * 発生時刻はオフセット付きの ISO 日時、営業日・受渡日は日付のみ、という
 * shared/events.ts の使い分けをそのまま守る。日付に時刻を持たせると
 * 日跨ぎの解釈が実装ごとに割れるため。
 */
import { z } from "zod";
import { invalidInput } from "./errors.ts";

const instantSchema = z.iso.datetime({ offset: true });
const dateSchema = z.iso.date();

/** オフセット付き ISO 日時 → Date。 */
export function parseInstant(value: string, label: string): Date {
  const parsed = instantSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidInput(`${label}: オフセット付きの ISO 日時で指定してください (${value})`);
  }
  return new Date(parsed.data);
}

/** YYYY-MM-DD であることだけを保証する。時刻は持たせない。 */
export function parseIsoDate(value: string, label: string): string {
  const parsed = dateSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidInput(`${label}: YYYY-MM-DD で指定してください (${value})`);
  }
  return parsed.data;
}

/** イベントに載せる形。ミリ秒付き UTC の ISO 文字列。 */
export function toIsoInstant(value: Date): string {
  return value.toISOString();
}
