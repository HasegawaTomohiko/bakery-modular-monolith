/**
 * 販売数量。
 *
 * イベント契約の `Quantity` は g / ml / piece を許すが、sales が扱うのは製品 (パン) の
 * 販売なので **個数 (piece) しか受け付けない**。原材料を g で売ることはないし、
 * 「クロワッサン 1.5 個」も存在しない。ここで弾いておかないと、
 * 販売確定イベントを受ける inventory 側で意味の分からない出庫指示になる。
 */
import type { Quantity } from "../../../shared/events.ts";
import { invalidInput } from "./errors.ts";

/** 個数に落とす。単位違い・非整数・0 以下はここで落とす。 */
export function toPieces(quantity: Quantity, label: string): number {
  if (quantity.unit !== "piece") {
    throw invalidInput(`${label}: 製品は個数 (piece) で数えます (unit=${quantity.unit})`);
  }
  if (!Number.isInteger(quantity.amount)) {
    throw invalidInput(`${label}: 個数は整数で指定してください (amount=${quantity.amount})`);
  }
  if (quantity.amount <= 0) {
    throw invalidInput(`${label}: 個数は 1 以上で指定してください (amount=${quantity.amount})`);
  }
  return quantity.amount;
}

/** 個数を契約の `Quantity` に戻す。イベントと公開ビューの両方で使う。 */
export function pieces(amount: number): Quantity {
  return { amount, unit: "piece" };
}
