/**
 * ユースケースが必要とする外側の口。
 *
 * ユースケースは drizzle も pg も知らない。infra がこの口を実装し、index.ts が繋ぐ。
 * こうしておくと、ユースケースの単体テストが DB 無しで書ける。
 *
 * `UnitOfWork` が repo と publish の**両方**を持っているのが肝。
 * 実装では同じ `tx` から作られるので、「在庫は動いたが発注点割れイベントが出ていない」が
 * 構造的に起きない (境界の強制 3/3)。
 */
import type { EventName, EventPayload, Quantity } from "../../../shared/events.ts";
import type { Ingredient, IngredientId } from "../domain/ingredient.ts";
import type { IngredientLot } from "../domain/ingredient-lot.ts";
import type { ProductLot } from "../domain/product-lot.ts";
import type { Unit } from "../domain/quantity.ts";
import type { StocktakeDiff } from "../domain/stocktake.ts";

export type NewIngredient = {
  readonly name: string;
  readonly unit: Unit;
  readonly reorderPoint: Quantity;
};

export type NewIngredientLot = {
  readonly ingredientId: IngredientId;
  readonly lotCode: string;
  readonly bestBefore: string;
  readonly amount: Quantity;
  readonly receivedAt: Date;
};

export type InventoryRepository = {
  insertIngredient(input: NewIngredient): Promise<IngredientId>;
  /**
   * イベントで届いた未登録の原材料 ID を受け入れるための行を作る。
   *
   * `ingredientId` は inventory が採番するので本来ここは通らない。それでも
   * 用意するのは、購読ハンドラで「知らない ID だから例外」をやると outbox の
   * 再送が止まらなくなるため。名前が分からない行として作り、棚卸と画面で直す。
   * 既にあれば何もせず既存を返す。
   */
  ensureIngredient(ingredientId: IngredientId, unit: Unit): Promise<Ingredient>;
  findIngredient(ingredientId: IngredientId): Promise<Ingredient | null>;
  listIngredients(): Promise<readonly Ingredient[]>;
  updateReorderPoint(ingredientId: IngredientId, reorderPoint: Quantity): Promise<void>;
  /**
   * 帳簿在庫と発注点割れフラグを同時に書く。
   * 別々に書けるようにすると「在庫は減ったがフラグが古い」状態が作れてしまう。
   */
  updateIngredientStock(
    ingredientId: IngredientId,
    onHand: Quantity,
    belowReorderPoint: boolean,
  ): Promise<void>;

  insertIngredientLot(lot: NewIngredientLot): Promise<void>;
  /** 残量のあるロットだけ。FEFO の並べ替えはドメイン側で行う。 */
  listOpenLots(ingredientId: IngredientId): Promise<readonly IngredientLot[]>;
  listAllOpenLots(): Promise<readonly IngredientLot[]>;
  updateLotRemaining(lotId: string, remaining: Quantity): Promise<void>;

  findProductLot(lotCode: string): Promise<ProductLot | null>;
  /** 在庫が 0 でないロットだけ。売り切ったロットは在庫一覧に出さない。 */
  listProductLots(): Promise<readonly ProductLot[]>;
  /** 製造完了で入庫する。既にあれば数量を足し、製造日・賞味期限を本物に直す。 */
  stockProductLot(lot: {
    readonly lotCode: string;
    readonly productId: string;
    readonly quantity: Quantity;
    readonly bestBefore: string;
    readonly producedAt: string;
  }): Promise<void>;
  /** 販売確定が製造完了より先に届いたときの仮のロット。 */
  ensureProvisionalProductLot(lot: {
    readonly lotCode: string;
    readonly productId: string;
    readonly bestBefore: string;
    readonly producedAt: string;
  }): Promise<ProductLot>;
  updateProductLotOnHand(lotCode: string, onHand: Quantity): Promise<void>;

  /** 棚卸1回分。差分の明細ごと残す (後からズレを追えるようにするため)。 */
  insertStocktake(countedAt: Date, diffs: readonly StocktakeDiff[]): Promise<string>;
};

/** outbox への発行。呼ばれた時点の業務トランザクションに乗る。 */
export type PublishEvent = <N extends EventName>(
  name: N,
  payload: EventPayload<N>,
) => Promise<void>;

export type UnitOfWork = {
  readonly repo: InventoryRepository;
  readonly publish: PublishEvent;
};

/** 1トランザクションを開いて `run` を走らせる。 */
export type Transactor = <T>(run: (uow: UnitOfWork) => Promise<T>) => Promise<T>;

/** 現在時刻。テストで固定できるようにユースケースの外から渡す。 */
export type Clock = () => Date;

export type InventoryDeps = {
  readonly transaction: Transactor;
  readonly now: Clock;
};
