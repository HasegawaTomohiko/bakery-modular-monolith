/**
 * application/ports.ts の実装 (drizzle 版)。
 *
 * 受け取る `Executor` は必ずユースケース (または購読ハンドラ) が開いた
 * トランザクション。ここで別の接続を掴むと outbox と業務データが別トランザクションに
 * なってしまう。
 *
 * 数量は numeric 列に入れているので pg からは文字列で返る。境界をまたぐ前に
 * `Quantity` に戻すのがこの層の仕事で、上のレイヤーには文字列を見せない。
 */
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Quantity } from "../../../shared/events.ts";
import type { Executor } from "../../../shared/tables.ts";
import type { InventoryRepository, NewIngredient, NewIngredientLot } from "../application/ports.ts";
import { invalid } from "../domain/errors.ts";
import type { Ingredient } from "../domain/ingredient.ts";
import type { IngredientLot } from "../domain/ingredient-lot.ts";
import { PRODUCT_UNIT, type ProductLot } from "../domain/product-lot.ts";
import { roundAmount, type Unit } from "../domain/quantity.ts";
import type { StocktakeDiff } from "../domain/stocktake.ts";
import {
  ingredientLots,
  ingredients,
  productLots,
  stocktakeLines,
  stocktakes,
} from "./db/schema.ts";

/** numeric 列は文字列で返る。契約上の単位はここで組み立てる。 */
function toQuantity(amount: string, unit: string): Quantity {
  const parsed = Number(amount);
  if (Number.isNaN(parsed)) {
    throw invalid(`数量が数値として読めません: ${amount}`);
  }
  return { amount: roundAmount(parsed), unit: toUnit(unit) };
}

function toUnit(unit: string): Unit {
  if (unit !== "g" && unit !== "ml" && unit !== "piece") {
    throw invalid(`契約外の単位が保存されています: ${unit}`);
  }
  return unit;
}

/** numeric 列へは文字列で渡す。float を経由させて丸め誤差を持ち込まないため。 */
function toAmountColumn(quantity: Quantity): string {
  return roundAmount(quantity.amount).toFixed(3);
}

type IngredientRow = typeof ingredients.$inferSelect;
type IngredientLotRow = typeof ingredientLots.$inferSelect;
type ProductLotRow = typeof productLots.$inferSelect;

function toIngredient(row: IngredientRow): Ingredient {
  const unit = toUnit(row.unit);
  return {
    ingredientId: row.id,
    name: row.name,
    unit,
    onHand: toQuantity(row.onHandAmount, unit),
    reorderPoint: toQuantity(row.reorderPointAmount, unit),
    belowReorderPoint: row.belowReorderPoint,
  };
}

function toIngredientLot(row: IngredientLotRow, unit: Unit): IngredientLot {
  return {
    lotId: row.id,
    ingredientId: row.ingredientId,
    lotCode: row.lotCode,
    bestBefore: row.bestBefore,
    remaining: toQuantity(row.remainingAmount, unit),
    receivedAt: row.receivedAt.toISOString(),
  };
}

function toProductLot(row: ProductLotRow): ProductLot {
  return {
    lotCode: row.lotCode,
    productId: row.productId,
    onHand: toQuantity(row.onHandAmount, PRODUCT_UNIT),
    bestBefore: row.bestBefore,
    producedAt: row.producedAt.toISOString(),
    provisional: row.provisional,
  };
}

export function createRepository(tx: Executor): InventoryRepository {
  /**
   * ロットは原材料の単位で読む。ロット行に単位を持たせないのは、
   * 同じ原材料のロットが違う単位になることがあり得ないため
   * (単位は原材料の属性であってロットの属性ではない)。
   */
  async function unitOf(ingredientId: string): Promise<Unit | null> {
    const rows = await tx
      .select({ unit: ingredients.unit })
      .from(ingredients)
      .where(eq(ingredients.id, ingredientId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toUnit(row.unit);
  }

  async function allUnits(): Promise<Map<string, Unit>> {
    const rows = await tx.select({ id: ingredients.id, unit: ingredients.unit }).from(ingredients);
    return new Map(rows.map((row) => [row.id, toUnit(row.unit)]));
  }

  return {
    async insertIngredient(input: NewIngredient) {
      const rows = await tx
        .insert(ingredients)
        .values({
          name: input.name,
          unit: input.unit,
          onHandAmount: "0",
          reorderPointAmount: toAmountColumn(input.reorderPoint),
        })
        .returning({ id: ingredients.id });
      const id = rows[0]?.id;
      if (id === undefined) {
        throw new Error("原材料の挿入結果が空でした");
      }
      return id;
    },

    async ensureIngredient(ingredientId, unit) {
      // 既にあれば何もしない。イベントは at-least-once なので競合しても壊れない形にする。
      await tx
        .insert(ingredients)
        .values({
          id: ingredientId,
          // 名前は inventory にしか無い情報で、イベントには載っていない。
          // 人が棚卸や画面で直せるよう、ひと目で仮と分かる名前にしておく。
          name: `未登録原材料 ${ingredientId}`,
          unit,
          onHandAmount: "0",
          reorderPointAmount: "0",
        })
        .onConflictDoNothing({ target: ingredients.id });

      const rows = await tx
        .select()
        .from(ingredients)
        .where(eq(ingredients.id, ingredientId))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new Error(`原材料 ${ingredientId} を作成できませんでした`);
      }
      return toIngredient(row);
    },

    async findIngredient(ingredientId) {
      const rows = await tx
        .select()
        .from(ingredients)
        .where(eq(ingredients.id, ingredientId))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toIngredient(row);
    },

    async listIngredients() {
      const rows = await tx.select().from(ingredients).orderBy(asc(ingredients.name));
      return rows.map(toIngredient);
    },

    async updateReorderPoint(ingredientId, reorderPoint) {
      await tx
        .update(ingredients)
        .set({ reorderPointAmount: toAmountColumn(reorderPoint) })
        .where(eq(ingredients.id, ingredientId));
    },

    async updateIngredientStock(ingredientId, onHand, belowReorderPoint) {
      await tx
        .update(ingredients)
        .set({ onHandAmount: toAmountColumn(onHand), belowReorderPoint })
        .where(eq(ingredients.id, ingredientId));
    },

    async insertIngredientLot(lot: NewIngredientLot) {
      await tx.insert(ingredientLots).values({
        ingredientId: lot.ingredientId,
        lotCode: lot.lotCode,
        bestBefore: lot.bestBefore,
        receivedAmount: toAmountColumn(lot.amount),
        remainingAmount: toAmountColumn(lot.amount),
        receivedAt: lot.receivedAt,
      });
    },

    async listOpenLots(ingredientId) {
      const unit = await unitOf(ingredientId);
      if (unit === null) return [];
      const rows = await tx
        .select()
        .from(ingredientLots)
        .where(
          and(
            eq(ingredientLots.ingredientId, ingredientId),
            ne(ingredientLots.remainingAmount, "0"),
          ),
        )
        .orderBy(asc(ingredientLots.bestBefore), asc(ingredientLots.receivedAt));
      return rows.map((row) => toIngredientLot(row, unit));
    },

    async listAllOpenLots() {
      const units = await allUnits();
      const rows = await tx
        .select()
        .from(ingredientLots)
        .where(ne(ingredientLots.remainingAmount, "0"))
        .orderBy(asc(ingredientLots.bestBefore), asc(ingredientLots.receivedAt));
      // ロットは原材料への外部キーを持つので、単位が引けないことは起きない。
      return rows.map((row) => toIngredientLot(row, units.get(row.ingredientId) ?? "g"));
    },

    async updateLotRemaining(lotId, remaining) {
      await tx
        .update(ingredientLots)
        .set({ remainingAmount: toAmountColumn(remaining) })
        .where(eq(ingredientLots.id, lotId));
    },

    async findProductLot(lotCode) {
      const rows = await tx
        .select()
        .from(productLots)
        .where(eq(productLots.lotCode, lotCode))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toProductLot(row);
    },

    async listProductLots() {
      // 在庫 0 のロット (売り切り・廃棄済み) は在庫一覧には出さない。
      // マイナスは異常として見えてほしいので除外しない。
      const rows = await tx
        .select()
        .from(productLots)
        .where(ne(productLots.onHandAmount, "0"))
        .orderBy(asc(productLots.bestBefore), asc(productLots.lotCode));
      return rows.map(toProductLot);
    },

    async stockProductLot(lot) {
      await tx
        .insert(productLots)
        .values({
          lotCode: lot.lotCode,
          productId: lot.productId,
          onHandAmount: toAmountColumn(lot.quantity),
          bestBefore: lot.bestBefore,
          producedAt: new Date(lot.producedAt),
          provisional: false,
        })
        .onConflictDoUpdate({
          target: productLots.lotCode,
          // 販売確定が先に届いて仮の行ができている場合がある。数量は足し込み、
          // 製造日と賞味期限は製造完了イベントの値で上書きする (そちらが本物)。
          set: {
            onHandAmount: sql`${productLots.onHandAmount} + excluded.on_hand_amount`,
            productId: sql`excluded.product_id`,
            bestBefore: sql`excluded.best_before`,
            producedAt: sql`excluded.produced_at`,
            provisional: false,
          },
        });
    },

    async ensureProvisionalProductLot(lot) {
      await tx
        .insert(productLots)
        .values({
          lotCode: lot.lotCode,
          productId: lot.productId,
          onHandAmount: "0",
          bestBefore: lot.bestBefore,
          producedAt: new Date(lot.producedAt),
          provisional: true,
        })
        .onConflictDoNothing({ target: productLots.lotCode });

      const rows = await tx
        .select()
        .from(productLots)
        .where(eq(productLots.lotCode, lot.lotCode))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new Error(`製品ロット ${lot.lotCode} を作成できませんでした`);
      }
      return toProductLot(row);
    },

    async updateProductLotOnHand(lotCode, onHand) {
      await tx
        .update(productLots)
        .set({ onHandAmount: toAmountColumn(onHand) })
        .where(eq(productLots.lotCode, lotCode));
    },

    async insertStocktake(countedAt, diffs: readonly StocktakeDiff[]) {
      const rows = await tx
        .insert(stocktakes)
        .values({ countedAt })
        .returning({ id: stocktakes.id });
      const stocktakeId = rows[0]?.id;
      if (stocktakeId === undefined) {
        throw new Error("棚卸の挿入結果が空でした");
      }

      if (diffs.length > 0) {
        await tx.insert(stocktakeLines).values(
          diffs.map((diff) => ({
            stocktakeId,
            targetKind: diff.target.kind,
            ingredientId: diff.target.kind === "ingredient" ? diff.target.ingredientId : null,
            lotCode: diff.target.kind === "product_lot" ? diff.target.lotCode : null,
            bookAmount: toAmountColumn(diff.book),
            countedAmount: toAmountColumn(diff.counted),
            diffAmount: toAmountColumn(diff.diff),
            unit: diff.book.unit,
          })),
        );
      }

      return stocktakeId;
    },
  };
}
