/**
 * catalog のドメインエラー。
 *
 * HTTP のステータスコードをドメインに持ち込まないため、意味だけを code で表す。
 * 対応付けは http/routes.ts が行う。他モジュールから呼ばれたときは
 * 例外としてそのまま伝わる (公開ユースケースは HTTP を経由しないため)。
 */

export type CatalogErrorCode = "product_not_found" | "product_not_sellable" | "invalid_product";

export class CatalogError extends Error {
  readonly code: CatalogErrorCode;

  constructor(code: CatalogErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 販売停止した商品も getProduct は返すので、これは「そもそも存在しない」場合だけ。 */
export class ProductNotFoundError extends CatalogError {
  constructor(productId: string) {
    super("product_not_found", `商品 ${productId} は存在しません`);
  }
}

/**
 * 販売停止済みの商品に、販売可であることを前提とした操作をした。
 *
 * 販売停止の二重実行もここに含む。二重に通すと `catalog.ProductDelisted` が
 * 2回出て、購読側が同じ商品の停止を2回処理することになるため。
 */
export class ProductNotSellableError extends CatalogError {
  constructor(productId: string) {
    super("product_not_sellable", `商品 ${productId} は販売停止済みです`);
  }
}

/** 入力が商品として成り立たない。HTTP なら zod が先に弾くが、他モジュール経由の呼び出しもある。 */
export class InvalidProductError extends CatalogError {
  constructor(message: string) {
    super("invalid_product", message);
  }
}

export function isCatalogError(error: unknown): error is CatalogError {
  return error instanceof CatalogError;
}
