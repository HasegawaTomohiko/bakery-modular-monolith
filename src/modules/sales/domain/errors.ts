/**
 * sales のドメインエラー。
 *
 * HTTP のステータスコードをドメインに持ち込まないため、意味だけを `code` で表す。
 * 対応付け (404 / 409 / 422) は http/routes.ts の責務。
 */

export type SalesErrorCode =
  /** 入力そのものが業務上成立しない (数量が 0、明細が空 等)。 */
  | "invalid_input"
  /** catalog に存在しない商品 ID。 */
  | "product_not_found"
  /** 販売停止中の商品を売ろうとした。 */
  | "product_not_sellable"
  | "reservation_not_found"
  /** 既に引き渡し済み / キャンセル済みの予約を操作しようとした。 */
  | "reservation_not_placed"
  /** 引き渡し明細が予約内容と一致しない。 */
  | "fulfillment_mismatch";

export class SalesError extends Error {
  readonly code: SalesErrorCode;

  constructor(code: SalesErrorCode, message: string) {
    super(message);
    this.name = "SalesError";
    this.code = code;
  }
}

export function invalidInput(message: string): SalesError {
  return new SalesError("invalid_input", message);
}
