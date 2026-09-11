/**
 * ユースケースが DB に求める操作 (ポート)。
 *
 * ここを型で切っておくのは、ユースケースの単体テストを DB 無しで回すため。
 * 実装は infra/store.ts (drizzle) が持ち、テストは in-memory の実装を差す。
 *
 * `publish` を同じ `CatalogTransaction` に置いているのが要点。
 * 業務データの書き込みと outbox への1行が**必ず同じトランザクション**に入る形にしてある。
 * ユースケース側が tx を取り違えて別トランザクションで publish する余地を残さないため
 * (docs/conventions/events.md「配送の保証」)。
 */
import type { EventName, EventPayload } from "../../../shared/events.ts";
import type { PriceRecord, Product, ProductId } from "../domain/product.ts";

/** 商品と、その価格履歴。catalog スキーマ内の2テーブルをまとめたもの。 */
export type StoredProduct = {
  readonly product: Product;
  readonly prices: readonly PriceRecord[];
};

export type CatalogTransaction = {
  insertProduct(product: Product, initialPrice: PriceRecord): Promise<void>;

  /** 販売停止した商品も返す。他モジュールが過去の参照を解決するため。 */
  findProduct(productId: ProductId): Promise<StoredProduct | null>;

  /** 販売可の商品だけ。 */
  listSellable(): Promise<readonly StoredProduct[]>;

  /** 価格改定は上書きではなく追記。過去の定価を消さないため。 */
  appendPrice(productId: ProductId, price: PriceRecord): Promise<void>;

  /**
   * 販売可の行だけを停止に更新し、更新できたかを返す。
   *
   * 「読んでから書く」の間に別の実行が停止させている可能性があるため、
   * 条件付き更新の結果でイベントを出すかどうかを決める。false なら二重停止。
   */
  markDelisted(productId: ProductId, reason: string, delistedAt: Date): Promise<boolean>;

  publish<N extends EventName>(name: N, payload: EventPayload<N>): Promise<void>;
};

export type CatalogStore = {
  /** 例外が出たらロールバックすること。ユースケースはこれを前提に書いてある。 */
  transaction<T>(run: (tx: CatalogTransaction) => Promise<T>): Promise<T>;
};

/**
 * ユースケースの実行文脈。
 *
 * 時刻と ID 生成を注入するのは、単体テストで固定するため。
 * `new Date()` をユースケースに直書きすると価格履歴の検証が書けなくなる。
 */
export type CatalogContext = {
  readonly store: CatalogStore;
  readonly now: () => Date;
  readonly newProductId: () => ProductId;
};
