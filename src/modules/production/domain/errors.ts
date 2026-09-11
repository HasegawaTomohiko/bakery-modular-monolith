/**
 * production のドメインエラー。
 *
 * HTTP のステータスコードをドメインに持ち込まないため、意味だけを型で表す。
 * 対応付け (400 / 404) は http/routes.ts が行う。
 */

/** 入力が業務ルールに反する。呼び出し側を直せば通る。 */
export class ProductionValidationError extends Error {
  override readonly name = "ProductionValidationError";
}

/** 参照先が無い。レシピ ID や営業日の指定間違い。 */
export class ProductionNotFoundError extends Error {
  override readonly name = "ProductionNotFoundError";
}
