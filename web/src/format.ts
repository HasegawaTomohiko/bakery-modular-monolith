/**
 * 表示のための変換。
 *
 * 数字が読めることを最優先にする。桁区切りを入れ、単位は API が返す
 * `Quantity` の unit をそのまま使う (原材料は g、製品は個)。
 * ここで単位を換算しない — 換算表を画面に持たせると、どの数字がどの単位なのかが
 * 画面ごとにずれる。
 */

export type Quantity = { readonly amount: number; readonly unit: "g" | "ml" | "piece" };

const numberFormat = new Intl.NumberFormat("ja-JP");

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

export function formatJpy(value: number): string {
  return `¥${numberFormat.format(value)}`;
}

export function formatQuantity(quantity: Quantity): string {
  if (quantity.unit === "piece") {
    return `${numberFormat.format(quantity.amount)} 個`;
  }
  return `${numberFormat.format(quantity.amount)} ${quantity.unit}`;
}

/** 日付のみ。時刻を混ぜない (賞味期限・営業日は日付で扱う契約)。 */
export function formatDate(value: string | null): string {
  return value ?? "—";
}

export function formatDateTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("ja-JP");
}

/** 識別子は全部は要らないが、突き合わせできる程度には出す。 */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * 今日の営業日 (JST の暦日)。
 * 営業日の定義は sales 側と揃えてある (パン屋の営業時間は日を跨がない)。
 */
export function todayInJst(): string {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}
