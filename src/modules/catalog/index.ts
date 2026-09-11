/**
 * catalog モジュールの公開 API (支援)。
 *
 * 責務: 販売用の商品定義、価格、販売状態、表示情報
 *
 * 他モジュールはこのファイル経由でしか catalog に依存できない
 * (docs/conventions/module-boundaries.md / .dependency-cruiser.cjs)。
 *
 * ここでの「クロワッサン」は**販売物**であり、名前・価格・アレルゲン表示を持つ。
 * production の「レシピとしてのクロワッサン」、inventory の「今朝焼いた24個」とは
 * 別のものなので、1つのモデルに押し込まない。
 *
 * 公開シグネチャは Phase 4a で確定した契約。実装 (Phase 4b) で変えないこと。
 */
import type { Subscription } from "../../shared/event-bus.ts";
import type { EventPayload } from "../../shared/events.ts";
import { catalogContext } from "./application/context.ts";
import * as useCases from "./application/use-cases.ts";

// ---------------------------------------------------------------------------
// 公開型
// ---------------------------------------------------------------------------

export type ProductId = string;

/** 特定原材料。表示義務があるので商品定義が持つ。 */
export type Allergen = "wheat" | "egg" | "milk" | "soba" | "peanut" | "shrimp" | "crab" | "walnut";

export type DelistReason = EventPayload<"catalog.ProductDelisted">["reason"];

/** 他モジュールが同期で引く商品情報。イベントでは運ばない。 */
export type ProductView = {
  readonly productId: ProductId;
  readonly name: string;
  readonly priceJpy: number;
  readonly allergens: readonly Allergen[];
  readonly sellable: boolean;
};

export type RegisterProductInput = {
  readonly name: string;
  readonly priceJpy: number;
  readonly allergens: readonly Allergen[];
};

export type ChangePriceInput = {
  readonly productId: ProductId;
  readonly priceJpy: number;
};

export type DelistProductInput = {
  readonly productId: ProductId;
  readonly reason: DelistReason;
};

// ---------------------------------------------------------------------------
// 公開ユースケース
// ---------------------------------------------------------------------------

export const catalog = {
  /** 商品を登録する。登録直後は販売可。 */
  registerProduct(input: RegisterProductInput): Promise<ProductId> {
    return useCases.registerProduct(catalogContext(), input);
  },

  changePrice(input: ChangePriceInput): Promise<void> {
    return useCases.changePrice(catalogContext(), input);
  },

  /** 販売を停止する。`catalog.ProductDelisted` を発行する。 */
  delistProduct(input: DelistProductInput): Promise<void> {
    return useCases.delistProduct(catalogContext(), input);
  },

  /** 他モジュールからの同期の問い合わせ口。 */
  getProduct(productId: ProductId): Promise<ProductView | null> {
    return useCases.getProduct(catalogContext(), productId);
  },

  listSellableProducts(): Promise<readonly ProductView[]> {
    return useCases.listSellableProducts(catalogContext());
  },
} as const;

// ---------------------------------------------------------------------------
// 購読
// ---------------------------------------------------------------------------

/** catalog は他文脈の状態変化を購読しない。商品定義は catalog が起点であるため。 */
export const catalogSubscriptions: readonly Subscription[] = [];
