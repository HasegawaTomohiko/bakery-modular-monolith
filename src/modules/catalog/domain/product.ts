/**
 * 商品 (販売物としてのパン)。
 *
 * ここでの「クロワッサン」は**名前・価格・アレルゲン表示を持つ販売物**であって、
 * production の「レシピ」でも inventory の「今朝焼いた24個というロット」でもない
 * (docs/conventions/module-boundaries.md)。したがってこのファイルに賞味期限も
 * 原材料も在庫数も出てこない。出てきたら境界が溶け始めている合図。
 *
 * DB も HTTP も知らない純粋なコード。
 */
import type { EventPayload } from "../../../shared/events.ts";
import { type Allergen, normalizeAllergens } from "./allergen.ts";
import { InvalidProductError } from "./errors.ts";

export type ProductId = string;

/**
 * 販売停止の理由。契約 (shared/events.ts) から導出する。
 * ここで独自に列挙するとイベントの enum と静かにずれるため。
 */
export type DelistReason = EventPayload<"catalog.ProductDelisted">["reason"];

/** 商品そのもの。価格は持たない (価格は履歴として別に持つ)。 */
export type Product = {
  readonly productId: ProductId;
  readonly name: string;
  readonly allergens: readonly Allergen[];
  /** 販売停止しても行は消さない。過去の売上・製造実績から参照されるため。 */
  readonly sellable: boolean;
  readonly delistedAt: Date | null;
  readonly delistReason: DelistReason | null;
  readonly registeredAt: Date;
};

/**
 * 「いつからいくらか」の1行。
 *
 * 現在価格だけを持つと、価格改定した瞬間に過去の売上を再計算できなくなる。
 * sales は販売時点の単価をイベントで運ぶので catalog 側が持つべきなのは
 * 現在価格ではなく「その時点の定価」で、そのためには履歴がいる。
 */
export type PriceRecord = {
  readonly priceJpy: number;
  readonly effectiveFrom: Date;
};

/** 他モジュールと HTTP に見せる形。index.ts の ProductView と同じ構造。 */
export type ProductView = {
  readonly productId: ProductId;
  readonly name: string;
  readonly priceJpy: number;
  readonly allergens: readonly Allergen[];
  readonly sellable: boolean;
};

/** 商品名の最大長。表示とラベル印字の都合で無制限にはしない。 */
const NAME_MAX_LENGTH = 100;

/**
 * 商品名を正規化する。前後の空白と連続空白を潰す。
 *
 * 「クロワッサン 」と「クロワッサン」が別商品として並ぶのを防ぐため。
 */
export function normalizeProductName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) {
    throw new InvalidProductError("商品名が空です");
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw new InvalidProductError(`商品名が長すぎます (${NAME_MAX_LENGTH} 文字まで)`);
  }
  return name;
}

/**
 * 価格を検証する。日本円は小数を持たないので整数。
 *
 * 0 円を許さないのは、無料配布は「販売」ではなく、価格改定で誤って 0 を入れたときに
 * 気づけなくなるため。無料で配るものは商品として登録しない。
 */
export function validatePriceJpy(priceJpy: number): number {
  if (!Number.isSafeInteger(priceJpy)) {
    throw new InvalidProductError(`価格は整数で指定してください: ${priceJpy}`);
  }
  if (priceJpy <= 0) {
    throw new InvalidProductError(`価格は 1 円以上で指定してください: ${priceJpy}`);
  }
  return priceJpy;
}

/** 登録直後の商品を組み立てる。登録直後は販売可。 */
export function registerProduct(params: {
  readonly productId: ProductId;
  readonly name: string;
  readonly allergens: readonly Allergen[];
  readonly registeredAt: Date;
}): Product {
  return {
    productId: params.productId,
    name: normalizeProductName(params.name),
    allergens: normalizeAllergens(params.allergens),
    sellable: true,
    delistedAt: null,
    delistReason: null,
    registeredAt: params.registeredAt,
  };
}

/**
 * ある時点で有効だった価格を選ぶ。売上の再計算に使う。
 *
 * 「その時点以前で最も新しい行」が答え。履歴の並び順に依存しないよう、
 * 呼び出し側の順序を前提にせずここで比較する。
 */
export function priceAsOf(history: readonly PriceRecord[], at: Date): PriceRecord | null {
  let found: PriceRecord | null = null;
  for (const record of history) {
    if (record.effectiveFrom.getTime() > at.getTime()) continue;
    if (found === null || record.effectiveFrom.getTime() > found.effectiveFrom.getTime()) {
      found = record;
    }
  }
  return found;
}

/**
 * 現在の定価 = 履歴の最新行。
 *
 * `priceAsOf(history, new Date())` にしないのは、純粋な関数の中で実時刻を読むと
 * テストが実行時刻に依存するため。将来日付の定価を作る口 (changePrice は
 * 適用開始日時を受け取らない) が無いので、「最新行」と「現時点で有効な行」は一致する。
 * 将来日付を扱えるようにするなら、その時点で priceAsOf に寄せる。
 *
 * 履歴が空になることは登録時の不変条件 (商品と初回価格を同じトランザクションで書く)
 * で起きない。
 */
export function currentPrice(history: readonly PriceRecord[]): PriceRecord {
  let latest: PriceRecord | null = null;
  for (const record of history) {
    if (latest === null || record.effectiveFrom.getTime() > latest.effectiveFrom.getTime()) {
      latest = record;
    }
  }
  if (latest === null) {
    throw new InvalidProductError("価格履歴の無い商品があります");
  }
  return latest;
}

/** 他モジュール・HTTP に見せる形へ落とす。 */
export function toProductView(product: Product, history: readonly PriceRecord[]): ProductView {
  return {
    productId: product.productId,
    name: product.name,
    priceJpy: currentPrice(history).priceJpy,
    allergens: product.allergens,
    sellable: product.sellable,
  };
}
