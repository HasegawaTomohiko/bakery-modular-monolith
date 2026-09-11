/**
 * inventory のドメインエラー。
 *
 * HTTP のステータスコードをドメインに持ち込まないため、原因の種類だけを持つ。
 * HTTP への対応付けは http/routes.ts の責務。
 *
 * 重要: **購読ハンドラの中ではこれを投げない。** 配送は at-least-once で、
 * 例外を投げると発行側の outbox に published 印が付かず、同じイベントが
 * 永久に再送されて worker が詰まる。在庫がマイナスになるような「業務的な異常」は
 * 例外ではなくアラート (listStockAlerts) として扱う。
 */

export type InventoryErrorKind =
  /** 対象が存在しない。 */
  | "not_found"
  /** 状態が合わない。 */
  | "conflict"
  /** 入力が業務ルールに反する。 */
  | "invalid";

export class InventoryError extends Error {
  readonly kind: InventoryErrorKind;

  constructor(kind: InventoryErrorKind, message: string) {
    super(message);
    this.name = "InventoryError";
    this.kind = kind;
  }
}

export function notFound(message: string): InventoryError {
  return new InventoryError("not_found", message);
}

export function conflict(message: string): InventoryError {
  return new InventoryError("conflict", message);
}

export function invalid(message: string): InventoryError {
  return new InventoryError("invalid", message);
}

export function isInventoryError(error: unknown): error is InventoryError {
  return error instanceof InventoryError;
}
