/**
 * purchasing のドメインエラー。
 *
 * HTTP のステータスコードをドメインに持ち込まないため、原因の種類だけを持つ。
 * HTTP への対応付けは http/routes.ts の責務。
 */

export type PurchasingErrorKind =
  /** 対象が存在しない。 */
  | "not_found"
  /** 状態が合わない (検収済みの入荷をもう一度検収する等)。 */
  | "conflict"
  /** 入力が業務ルールに反する。 */
  | "invalid";

export class PurchasingError extends Error {
  readonly kind: PurchasingErrorKind;

  constructor(kind: PurchasingErrorKind, message: string) {
    super(message);
    this.name = "PurchasingError";
    this.kind = kind;
  }
}

export function notFound(message: string): PurchasingError {
  return new PurchasingError("not_found", message);
}

export function conflict(message: string): PurchasingError {
  return new PurchasingError("conflict", message);
}

export function invalid(message: string): PurchasingError {
  return new PurchasingError("invalid", message);
}

export function isPurchasingError(error: unknown): error is PurchasingError {
  return error instanceof PurchasingError;
}
