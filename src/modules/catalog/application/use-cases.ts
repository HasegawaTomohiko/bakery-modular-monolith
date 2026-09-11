/**
 * catalog のユースケース。トランザクション境界はここ。
 *
 * 公開面 (index.ts) と HTTP (http/routes.ts) の両方がこれを呼ぶ。
 * 同じ操作が2つの入口で別の実装になるのを防ぐため、業務のルールは全部ここに置く。
 */
import type { Allergen } from "../domain/allergen.ts";
import { ProductNotFoundError, ProductNotSellableError } from "../domain/errors.ts";
import {
  registerProduct as buildProduct,
  currentPrice,
  type DelistReason,
  normalizeProductName,
  type PriceRecord,
  type ProductId,
  type ProductView,
  toProductView,
  validatePriceJpy,
} from "../domain/product.ts";
import type { CatalogContext, StoredProduct } from "./store.ts";

export type RegisterProductCommand = {
  readonly name: string;
  readonly priceJpy: number;
  readonly allergens: readonly Allergen[];
};

export type ChangePriceCommand = {
  readonly productId: ProductId;
  readonly priceJpy: number;
};

export type DelistProductCommand = {
  readonly productId: ProductId;
  readonly reason: DelistReason;
};

/** 商品を登録する。登録直後は販売可。初回価格が履歴の1行目になる。 */
export async function registerProduct(
  context: CatalogContext,
  command: RegisterProductCommand,
): Promise<ProductId> {
  // 保存する前に落とす。DB に入ってから気づくと修正が履歴に残るため。
  const name = normalizeProductName(command.name);
  const priceJpy = validatePriceJpy(command.priceJpy);
  const registeredAt = context.now();

  const product = buildProduct({
    productId: context.newProductId(),
    name,
    allergens: command.allergens,
    registeredAt,
  });

  await context.store.transaction(async (tx) => {
    // 商品と初回価格は同じトランザクション。価格の無い商品を存在させないため。
    await tx.insertProduct(product, { priceJpy, effectiveFrom: registeredAt });
  });

  return product.productId;
}

/**
 * 価格を改定する。上書きではなく履歴への追記。
 *
 * 状態変化ではあるがイベントは出さない。契約 (shared/events.ts) にある catalog 発の
 * イベントは販売停止だけで、価格は他モジュールが同期で引くもの。sales は販売時点の
 * 単価を自分のイベントで運ぶので、改定を知る必要がない。
 */
export async function changePrice(
  context: CatalogContext,
  command: ChangePriceCommand,
): Promise<void> {
  const priceJpy = validatePriceJpy(command.priceJpy);
  const effectiveFrom = context.now();

  await context.store.transaction(async (tx) => {
    const stored = await tx.findProduct(command.productId);
    if (stored === null) {
      throw new ProductNotFoundError(command.productId);
    }
    // 販売停止した商品の定価を動かしても意味が無く、過去の売上の再計算だけを狂わせる。
    if (!stored.product.sellable) {
      throw new ProductNotSellableError(command.productId);
    }
    // 同じ値なら履歴を増やさない。再送や二度押しで「280円→280円」の行が積まれると、
    // 履歴が「いつ値段が変わったか」を表さなくなり、売上の照合で読み違える。
    if (currentPrice(stored.prices).priceJpy === priceJpy) {
      return;
    }
    await tx.appendPrice(command.productId, { priceJpy, effectiveFrom });
  });
}

/**
 * 販売を停止する。行は消さない。過去の売上や製造実績から参照されるため。
 *
 * `catalog.ProductDelisted` を**業務データの更新と同じトランザクションで** outbox に積む。
 * 「販売停止したのに通知が出ない」も「通知は出たのに停止していない」も起きない
 * (docs/conventions/events.md)。
 */
export async function delistProduct(
  context: CatalogContext,
  command: DelistProductCommand,
): Promise<void> {
  const delistedAt = context.now();

  await context.store.transaction(async (tx) => {
    const stored = await tx.findProduct(command.productId);
    if (stored === null) {
      throw new ProductNotFoundError(command.productId);
    }

    // 条件付き更新。同時に2本走っても停止できるのは片方だけになる。
    const delisted = await tx.markDelisted(command.productId, command.reason, delistedAt);
    if (!delisted) {
      // 既に停止済み。ここで抜けないとイベントが2回出て、購読側が二重に処理する。
      throw new ProductNotSellableError(command.productId);
    }

    // 運ぶのは「状態が変わった」という事実だけ。名前・価格・アレルゲン表示は
    // 購読側が catalog.getProduct() に同期で問い合わせる。
    await tx.publish("catalog.ProductDelisted", {
      productId: command.productId,
      delistedAt: delistedAt.toISOString(),
      reason: command.reason,
    });
  });
}

/**
 * 他モジュールからの同期の問い合わせ口。
 *
 * **販売停止した商品も返す。** production の過去の製造実績や sales の過去の売上が
 * 参照している商品 ID を解決できなくなるため。販売可かどうかは sellable で判断する。
 */
export async function getProduct(
  context: CatalogContext,
  productId: ProductId,
): Promise<ProductView | null> {
  const stored = await context.store.transaction((tx) => tx.findProduct(productId));
  return stored === null ? null : toView(stored);
}

/** 販売可の商品だけ。停止したものは出さない。 */
export async function listSellableProducts(
  context: CatalogContext,
): Promise<readonly ProductView[]> {
  const stored = await context.store.transaction((tx) => tx.listSellable());
  return stored.map(toView);
}

/** 価格履歴つきの読み取り。HTTP の詳細表示で使う。 */
export async function getProductWithPrices(
  context: CatalogContext,
  productId: ProductId,
): Promise<{ view: ProductView; prices: readonly PriceRecord[] } | null> {
  const stored = await context.store.transaction((tx) => tx.findProduct(productId));
  if (stored === null) return null;
  return { view: toView(stored), prices: sortByEffectiveFrom(stored.prices) };
}

function toView(stored: StoredProduct): ProductView {
  return toProductView(stored.product, stored.prices);
}

function sortByEffectiveFrom(prices: readonly PriceRecord[]): readonly PriceRecord[] {
  return [...prices].sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
}
