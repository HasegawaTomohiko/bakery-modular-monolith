/**
 * 購読ハンドラ。inventory は5イベント中3つを購読する。
 *
 *   purchasing.GoodsReceiptAccepted  → 原材料を入庫
 *   production.ProductionCompleted   → 原材料を消費し、製品ロットを入庫
 *   sales.SaleCompleted              → 製品を出庫
 *
 * **ここでは業務的な異常で例外を投げない。**
 * 配送は at-least-once で、例外を投げると発行側の outbox に published 印が付かず、
 * 同じイベントが永久に再送されて worker が詰まる。在庫がマイナスになる、
 * 知らない原材料 ID が来る、単位がずれている — どれも処理を止める理由にはしない。
 * マイナスは listStockAlerts のアラートとして人に見せ、棚卸で補正する。
 *
 * 冪等性は shared/inbox.ts が (event_id, handler) で担保するので、ここでは考えない。
 * 渡ってくる `tx` は inbox の記録と同じトランザクション。
 */
import type { EventPayload, Quantity } from "../../../shared/events.ts";
import type { Ingredient } from "../domain/ingredient.ts";
import { PRODUCT_UNIT, type ProductLot, ship } from "../domain/product-lot.ts";
import { coerceUnit } from "../domain/quantity.ts";
import type { UnitOfWork } from "./ports.ts";
import { applyIngredientDelta } from "./stock.ts";

/**
 * 1イベントの中で同じ原材料が2行に出てくることがある。
 * DB から読み直すと1行目の更新が反映済みとはいえ往復が増えるので、
 * 更新後の姿をこのトランザクションの中だけで持ち回る。
 */
function ingredientCache(uow: UnitOfWork): {
  load: (ingredientId: string, unit: Quantity["unit"]) => Promise<Ingredient>;
  save: (ingredient: Ingredient) => void;
} {
  const loaded = new Map<string, Ingredient>();
  return {
    async load(ingredientId, unit) {
      const cached = loaded.get(ingredientId);
      if (cached !== undefined) return cached;
      // 未登録の ID でも行を作って受け入れる。ここで落とすと再送が止まらない。
      const ingredient = await uow.repo.ensureIngredient(ingredientId, unit);
      loaded.set(ingredientId, ingredient);
      return ingredient;
    },
    save(ingredient) {
      loaded.set(ingredient.ingredientId, ingredient);
    },
  };
}

/** イベントの発生時刻 (オフセット付き) から日付だけを取り出す。 */
function dateOf(isoDatetime: string): string {
  return isoDatetime.slice(0, 10);
}

// ---------------------------------------------------------------------------
// purchasing.GoodsReceiptAccepted → 原材料を入庫
// ---------------------------------------------------------------------------

/**
 * 検収済みの入荷を原材料在庫に反映する。
 *
 * 入庫はロット単位で持つ。仕入先のロット番号と賞味期限が付いてくるので、
 * 払い出しを FEFO にでき、期限切れも検出できる。
 */
export async function receiveAcceptedGoods(
  uow: UnitOfWork,
  payload: EventPayload<"purchasing.GoodsReceiptAccepted">,
): Promise<void> {
  const cache = ingredientCache(uow);
  const acceptedAt = new Date(payload.acceptedAt);

  for (const line of payload.lines) {
    const ingredient = await cache.load(line.ingredientId, line.quantity.unit);
    const amount = coerceUnit(line.quantity, ingredient.unit);

    await uow.repo.insertIngredientLot({
      ingredientId: ingredient.ingredientId,
      lotCode: line.lotCode,
      bestBefore: line.bestBefore,
      amount,
      receivedAt: acceptedAt,
    });
    // 帳簿在庫を増やす。直前がマイナス (裏付けの無い消費) だった分は、
    // この入荷から先に相殺される。
    cache.save(await applyIngredientDelta(uow, ingredient, amount, acceptedAt));
  }
}

// ---------------------------------------------------------------------------
// production.ProductionCompleted → 原材料を消費し、製品ロットを入庫
// ---------------------------------------------------------------------------

/**
 * 製造完了を在庫に反映する。原材料が減り、製品ロットが増える。
 *
 * 消費量は**イベントに載っている値をそのまま信じる**。レシピは production の
 * 持ち物なので、inventory がレシピを引くと境界を越える (events.md)。
 * 「レシピ×数量」の計算は発行側で終わっている。
 */
export async function consumeAndStockProduction(
  uow: UnitOfWork,
  payload: EventPayload<"production.ProductionCompleted">,
): Promise<void> {
  const cache = ingredientCache(uow);
  const completedAt = new Date(payload.completedAt);

  for (const line of payload.consumedIngredients) {
    const ingredient = await cache.load(line.ingredientId, line.quantity.unit);
    const consumed = coerceUnit(line.quantity, ingredient.unit);
    // 在庫が足りなくてもマイナスで受ける。製造は既に済んでおり、事実として
    // 原材料は減っている。足りないのは入荷検収がまだ届いていないか記録漏れ。
    cache.save(
      await applyIngredientDelta(
        uow,
        ingredient,
        { amount: -consumed.amount, unit: consumed.unit },
        completedAt,
      ),
    );
  }

  // 製品ロットの入庫。ロットコードは production が付けたものをそのまま使う。
  await uow.repo.stockProductLot({
    lotCode: payload.lotCode,
    productId: payload.productId,
    quantity: coerceUnit(payload.producedQuantity, PRODUCT_UNIT),
    bestBefore: payload.bestBefore,
    producedAt: payload.completedAt,
  });
}

// ---------------------------------------------------------------------------
// sales.SaleCompleted → 製品を出庫
// ---------------------------------------------------------------------------

/**
 * 販売確定を在庫に反映する。売れたロットから出庫する。
 *
 * 製造完了より先に届くことがある (結果整合)。そのときはロットが無いので
 * 仮のロットを作ってマイナスで受け止める。レジは通っているのに在庫が動かない、
 * という食い違いを作らないため。製造完了が後から届けば本物の値に上書きされる。
 */
export async function shipSoldProducts(
  uow: UnitOfWork,
  payload: EventPayload<"sales.SaleCompleted">,
): Promise<void> {
  const lots = new Map<string, ProductLot>();

  for (const line of payload.lines) {
    let lot = lots.get(line.lotCode);
    if (lot === undefined) {
      lot =
        (await uow.repo.findProductLot(line.lotCode)) ??
        (await uow.repo.ensureProvisionalProductLot({
          lotCode: line.lotCode,
          productId: line.productId,
          // 製品は当日限り。製造完了が届くまでの暫定値として販売日を置く。
          bestBefore: dateOf(payload.soldAt),
          producedAt: payload.soldAt,
        }));
    }

    const onHand = ship(lot, coerceUnit(line.quantity, PRODUCT_UNIT));
    await uow.repo.updateProductLotOnHand(lot.lotCode, onHand);
    lots.set(lot.lotCode, { ...lot, onHand });
  }
}
