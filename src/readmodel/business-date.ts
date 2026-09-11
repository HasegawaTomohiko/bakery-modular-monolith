/**
 * 参照モデルの営業日。
 *
 * **「1日」は Asia/Tokyo のカレンダー日付 (00:00 以上 翌 00:00 未満) とする。**
 * これは sales が持っている営業日の定義と同じもの
 * (src/modules/sales/domain/business-date.ts)。店舗は日本にあるので JST 固定でよい。
 * 同じ定義を readmodel にも書くのは、モジュールを import できないため
 * (参照モデルがモジュールに依存すると、そこが JOIN の代わりになる)。
 *
 * なぜ「文字列の先頭10文字」ではないのか:
 * 契約 (shared/events.ts) の時刻はオフセット付きだが、**発行側によって書き方が違う**。
 *
 *   purchasing / inventory / sales — `Date.toISOString()` で UTC (`...T22:00:00.000Z`)
 *   production                     — 入力された文字列のまま (`...T07:30:00+09:00`)
 *
 * 文字列の日付部分をそのまま採ると、UTC で書かれた側だけが日を跨ぐ。
 * 朝 7 時の販売 (= 前日 22:00Z) が前日の売上に入り、同じ日の製造数と並ばなくなる。
 * 絶対時刻に直してから JST の暦日に落とせば、どちらの書き方でも同じ営業日になる。
 */

/** 店舗のタイムゾーン。複数タイムゾーンに店を持つようになったら店舗ごとの設定が要る。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const DATE_PART = /^(\d{4}-\d{2}-\d{2})/;

/**
 * イベントの発生時刻から営業日 (YYYY-MM-DD) を求める。
 *
 * 解釈できない値でも例外を投げず、日付部分に退避する。**投影で例外を投げると
 * 発行側の outbox に published 印が付かず、同じイベントが永久に再送されて
 * worker が詰まる**ため。参照モデルの1行のために業務の配送を止めない。
 */
export function businessDateOf(isoDatetime: string): string {
  const instant = new Date(isoDatetime);
  if (Number.isNaN(instant.getTime())) {
    return DATE_PART.exec(isoDatetime)?.[1] ?? isoDatetime;
  }
  // JST の壁時計時刻に直してから日付部分だけ取る。
  return new Date(instant.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}
