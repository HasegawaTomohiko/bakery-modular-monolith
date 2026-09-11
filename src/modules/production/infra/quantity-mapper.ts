/**
 * DB の (amount, unit) 2 列と契約の Quantity を行き来する。
 *
 * 単位を text 列に持つので、読み出しは契約のスキーマで検証してから domain に渡す。
 * 手で as を書くと、列に "kg" が紛れ込んだときに気づけるのが inventory 側になる。
 */
import { type Quantity, quantitySchema } from "../../../shared/events.ts";

export function toQuantity(amount: number, unit: string): Quantity {
  return quantitySchema.parse({ amount, unit });
}
