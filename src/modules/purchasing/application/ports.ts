/**
 * ユースケースが必要とする外側の口。
 *
 * ユースケースは drizzle も pg も知らない。infra がこの口を実装し、index.ts が繋ぐ。
 * こうしておくと、ユースケースの単体テストが DB 無しで書ける。
 *
 * `UnitOfWork` が repo と publish の**両方**を持っているのが肝。
 * 実装では同じ `tx` から作られるので、「業務データは書けたがイベントが出ていない」が
 * 構造的に起きない (境界の強制 3/3)。
 */
import type { EventName, EventPayload } from "../../../shared/events.ts";
import type { GoodsReceipt, PurchaseOrder, PurchaseOrderStatus } from "../domain/purchase-order.ts";
import type { PurchaseSuggestion, SuggestionStatus } from "../domain/suggestion.ts";

export type Supplier = {
  readonly supplierId: string;
  readonly name: string;
  readonly leadTimeDays: number;
};

export type NewPurchaseOrder = {
  readonly supplierId: string;
  readonly orderedAt: Date;
  readonly lines: PurchaseOrder["lines"];
};

export type NewGoodsReceipt = {
  readonly purchaseOrderId: string;
  readonly receivedAt: Date;
  readonly lines: GoodsReceipt["lines"];
};

export type NewSuggestion = {
  readonly ingredientId: string;
  readonly suggestedQuantity: PurchaseSuggestion["suggestedQuantity"];
  readonly onHandAtDetection: PurchaseSuggestion["onHandAtDetection"];
  readonly createdAt: Date;
};

export type PurchasingRepository = {
  insertSupplier(supplier: Omit<Supplier, "supplierId">): Promise<string>;
  findSupplier(supplierId: string): Promise<Supplier | null>;

  insertPurchaseOrder(order: NewPurchaseOrder): Promise<string>;
  findPurchaseOrder(purchaseOrderId: string): Promise<PurchaseOrder | null>;
  updatePurchaseOrderStatus(purchaseOrderId: string, status: PurchaseOrderStatus): Promise<void>;

  insertGoodsReceipt(receipt: NewGoodsReceipt): Promise<string>;
  findGoodsReceipt(goodsReceiptId: string): Promise<GoodsReceipt | null>;
  markGoodsReceiptAccepted(goodsReceiptId: string, acceptedAt: Date): Promise<void>;

  /**
   * 提案を1件足す。同じ原材料に未対応の提案が既にあれば**何もせず null を返す**。
   * 判定は DB の部分ユニークインデックスに任せる (アプリ側の事前チェックだけだと、
   * 同じイベントが並行して届いたときに2件入りうるため)。
   */
  insertSuggestionIfNoneOpen(suggestion: NewSuggestion): Promise<string | null>;
  listSuggestions(status: SuggestionStatus): Promise<readonly PurchaseSuggestion[]>;
  /** 指定した原材料の未対応提案を発注済みにする。対応付いた件数を返す。 */
  markSuggestionsOrdered(
    ingredientIds: readonly string[],
    purchaseOrderId: string,
  ): Promise<number>;
};

/** outbox への発行。呼ばれた時点の業務トランザクションに乗る。 */
export type PublishEvent = <N extends EventName>(
  name: N,
  payload: EventPayload<N>,
) => Promise<void>;

export type UnitOfWork = {
  readonly repo: PurchasingRepository;
  readonly publish: PublishEvent;
};

/** 1トランザクションを開いて `run` を走らせる。 */
export type Transactor = <T>(run: (uow: UnitOfWork) => Promise<T>) => Promise<T>;

/** 現在時刻。テストで固定できるようにユースケースの外から渡す。 */
export type Clock = () => Date;

export type PurchasingDeps = {
  readonly transaction: Transactor;
  readonly now: Clock;
};
