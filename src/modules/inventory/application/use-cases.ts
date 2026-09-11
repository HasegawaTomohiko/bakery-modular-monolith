/**
 * inventory の公開ユースケース。
 *
 * ここがトランザクション境界。業務データの書き込みと `publish()` を同じ
 * `UnitOfWork` の中で行うので、片方だけ成功することがない (境界の強制 3/3)。
 *
 * 他モジュールを同期で呼ぶところは無い。`productId` と `lotCode` は他文脈の
 * 識別子として持つだけで、商品名も価格もレシピも inventory は持たない。
 */
import type { Quantity } from "../../../shared/events.ts";
import { invalid, notFound } from "../domain/errors.ts";
import type { Ingredient, IngredientId } from "../domain/ingredient.ts";
import { expiredLots, type IngredientLot, nearestBestBefore } from "../domain/ingredient-lot.ts";
import { PRODUCT_UNIT } from "../domain/product-lot.ts";
import type { Unit } from "../domain/quantity.ts";
import { assertNonNegative, assertSameUnit, isNegative, quantityOf } from "../domain/quantity.ts";
import { diffOf, type StocktakeDiff } from "../domain/stocktake.ts";
import type { InventoryDeps, UnitOfWork } from "./ports.ts";
import { applyIngredientDelta } from "./stock.ts";

// ---------------------------------------------------------------------------
// 公開面に返す形 (index.ts の型と同じ形。index.ts を import すると循環するため再掲)
// ---------------------------------------------------------------------------

export type IngredientStockView = {
  readonly ingredientId: IngredientId;
  readonly name: string;
  readonly onHand: Quantity;
  readonly reorderPoint: Quantity;
  readonly nearestBestBefore: string | null;
};

export type ProductLotView = {
  readonly lotCode: string;
  readonly productId: string;
  readonly onHand: Quantity;
  readonly bestBefore: string;
  readonly producedAt: string;
};

export type StockAlert =
  | {
      readonly kind: "negative_ingredient_stock";
      readonly ingredientId: IngredientId;
      readonly onHand: Quantity;
    }
  | { readonly kind: "negative_product_stock"; readonly lotCode: string; readonly onHand: Quantity }
  | {
      readonly kind: "expired_ingredient";
      readonly ingredientId: IngredientId;
      readonly bestBefore: string;
    };

// ---------------------------------------------------------------------------
// 原材料の登録と発注点
// ---------------------------------------------------------------------------

export type RegisterIngredientInput = {
  readonly name: string;
  readonly unit: Unit;
  readonly reorderPoint: Quantity;
};

/**
 * 原材料を登録する。`ingredientId` は **inventory が採番する**。
 * purchasing と production はこの ID を識別子としてだけ持つ。
 */
export async function registerIngredient(
  deps: InventoryDeps,
  input: RegisterIngredientInput,
): Promise<IngredientId> {
  const name = input.name.trim();
  if (name === "") {
    throw invalid("原材料の名前は必須です");
  }
  assertSameUnit({ amount: 0, unit: input.unit }, input.reorderPoint, "発注点の単位");
  // 発注点が負の在庫というのは意味を成さない。0 は「発注点なし」として許す。
  assertNonNegative(input.reorderPoint, "発注点");

  return deps.transaction((uow) =>
    uow.repo.insertIngredient({ name, unit: input.unit, reorderPoint: input.reorderPoint }),
  );
}

export type SetReorderPointInput = {
  readonly ingredientId: IngredientId;
  readonly reorderPoint: Quantity;
};

/**
 * 発注点を変える。
 *
 * 変更後に評価し直すのは、閾値を上げた結果それまで足りていた在庫が
 * 足りなくなることがあるため。発行は「上回る → 下回る」の変化時だけなので、
 * 既に割れている状態で発注点をいじっても二重には出ない。
 */
export async function setReorderPoint(
  deps: InventoryDeps,
  input: SetReorderPointInput,
): Promise<void> {
  assertNonNegative(input.reorderPoint, "発注点");

  await deps.transaction(async (uow) => {
    const ingredient = await requireIngredient(uow, input.ingredientId);
    assertSameUnit(ingredient.onHand, input.reorderPoint, "発注点の単位");

    await uow.repo.updateReorderPoint(input.ingredientId, input.reorderPoint);
    // 在庫は動かさず (delta 0)、新しい発注点で評価だけやり直す。
    await applyIngredientDelta(
      uow,
      { ...ingredient, reorderPoint: input.reorderPoint },
      quantityOf(0, ingredient.unit),
      deps.now(),
    );
  });
}

// ---------------------------------------------------------------------------
// 参照
// ---------------------------------------------------------------------------

export async function getIngredientStock(
  deps: InventoryDeps,
  ingredientId: IngredientId,
): Promise<IngredientStockView | null> {
  return deps.transaction(async (uow) => {
    const ingredient = await uow.repo.findIngredient(ingredientId);
    if (ingredient === null) return null;
    const lots = await uow.repo.listOpenLots(ingredientId);
    return toStockView(ingredient, lots);
  });
}

export async function listIngredientStock(
  deps: InventoryDeps,
): Promise<readonly IngredientStockView[]> {
  return deps.transaction(async (uow) => {
    const ingredients = await uow.repo.listIngredients();
    const lots = await uow.repo.listAllOpenLots();
    return ingredients.map((ingredient) =>
      toStockView(
        ingredient,
        lots.filter((lot) => lot.ingredientId === ingredient.ingredientId),
      ),
    );
  });
}

export async function listProductLots(deps: InventoryDeps): Promise<readonly ProductLotView[]> {
  return deps.transaction(async (uow) => {
    const lots = await uow.repo.listProductLots();
    return lots.map((lot) => ({
      lotCode: lot.lotCode,
      productId: lot.productId,
      onHand: lot.onHand,
      bestBefore: lot.bestBefore,
      producedAt: lot.producedAt,
    }));
  });
}

/**
 * 在庫の異常。処理は止めず、ここで人に見せる。
 *
 *   negative_ingredient_stock — 記録に無い消費、またはイベントの遅延
 *   negative_product_stock    — 製造完了より先に販売確定が届いた等
 *   expired_ingredient        — 期限切れの残量。廃棄するか使い切るかは人が決める
 */
export async function listStockAlerts(deps: InventoryDeps): Promise<readonly StockAlert[]> {
  const today = deps.now().toISOString().slice(0, 10);

  return deps.transaction(async (uow) => {
    const alerts: StockAlert[] = [];

    for (const ingredient of await uow.repo.listIngredients()) {
      if (isNegative(ingredient.onHand)) {
        alerts.push({
          kind: "negative_ingredient_stock",
          ingredientId: ingredient.ingredientId,
          onHand: ingredient.onHand,
        });
      }
    }

    for (const lot of await uow.repo.listProductLots()) {
      if (isNegative(lot.onHand)) {
        alerts.push({ kind: "negative_product_stock", lotCode: lot.lotCode, onHand: lot.onHand });
      }
    }

    // 同じ原材料の同じ期限のロットが複数あっても、人に見せる事実は1つ。
    const seen = new Set<string>();
    for (const lot of expiredLots(await uow.repo.listAllOpenLots(), today)) {
      const key = `${lot.ingredientId}|${lot.bestBefore}`;
      if (seen.has(key)) continue;
      seen.add(key);
      alerts.push({
        kind: "expired_ingredient",
        ingredientId: lot.ingredientId,
        bestBefore: lot.bestBefore,
      });
    }

    return alerts;
  });
}

// ---------------------------------------------------------------------------
// 棚卸
// ---------------------------------------------------------------------------

export type RecordStocktakeInput = {
  readonly countedAt: string;
  readonly ingredients: readonly {
    readonly ingredientId: IngredientId;
    readonly counted: Quantity;
  }[];
  readonly productLots: readonly { readonly lotCode: string; readonly counted: Quantity }[];
};

/**
 * 棚卸を記録する。実地の数がそのまま新しい帳簿在庫になる。
 *
 * 在庫は棚卸で補正する近似値であり、これが唯一の正攻法の補正手段。
 * ただの上書きにせず差分 (帳簿と実地のズレ) を明細に残すのは、
 * ズレが常態化していることに後から気づけるようにするため。
 */
export async function recordStocktake(
  deps: InventoryDeps,
  input: RecordStocktakeInput,
): Promise<void> {
  const countedAt = parseInstant(input.countedAt, "countedAt");
  if (input.ingredients.length === 0 && input.productLots.length === 0) {
    throw invalid("棚卸の明細が空です");
  }

  await deps.transaction(async (uow) => {
    const diffs: StocktakeDiff[] = [];

    for (const line of input.ingredients) {
      // 実地在庫がマイナスということは現実にはあり得ない (棚に -2kg は置けない)。
      assertNonNegative(line.counted, `棚卸の実地在庫 (${line.ingredientId})`);
      const ingredient = await requireIngredient(uow, line.ingredientId);
      const diff = diffOf(
        { kind: "ingredient", ingredientId: line.ingredientId },
        ingredient.onHand,
        line.counted,
      );
      diffs.push(diff);
      // 差分だけ動かす。減る向きならロットも FEFO で引き当て、発注点も評価される。
      await applyIngredientDelta(uow, ingredient, diff.diff, countedAt);
    }

    for (const line of input.productLots) {
      assertNonNegative(line.counted, `棚卸の実地在庫 (${line.lotCode})`);
      const lot = await uow.repo.findProductLot(line.lotCode);
      if (lot === null) {
        // ロットコードは production が付けるもので inventory は採番しない。
        // 知らないロットを数えたということは、製造完了がまだ届いていないか
        // ロットコードの打ち間違い。どちらも人が直すべきなので、ここは止める。
        throw notFound(`製品ロットが見つかりません: ${line.lotCode}`);
      }
      const counted = quantityOf(line.counted.amount, PRODUCT_UNIT);
      diffs.push(diffOf({ kind: "product_lot", lotCode: line.lotCode }, lot.onHand, counted));
      await uow.repo.updateProductLotOnHand(line.lotCode, counted);
    }

    await uow.repo.insertStocktake(countedAt, diffs);
  });
}

// ---------------------------------------------------------------------------

async function requireIngredient(uow: UnitOfWork, ingredientId: IngredientId): Promise<Ingredient> {
  const ingredient = await uow.repo.findIngredient(ingredientId);
  if (ingredient === null) {
    throw notFound(`原材料が見つかりません: ${ingredientId}`);
  }
  return ingredient;
}

function toStockView(ingredient: Ingredient, lots: readonly IngredientLot[]): IngredientStockView {
  return {
    ingredientId: ingredient.ingredientId,
    name: ingredient.name,
    onHand: ingredient.onHand,
    reorderPoint: ingredient.reorderPoint,
    nearestBestBefore: nearestBestBefore(lots),
  };
}

function parseInstant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw invalid(`${field} が日時として読めません: ${value}`);
  }
  return parsed;
}
