/**
 * レシピの永続化。
 *
 * レシピは更新せず版を重ねるので、ここに update は無い。
 */
import { desc, eq } from "drizzle-orm";
import type { Executor } from "../../../shared/tables.ts";
import type { RecipeRepository } from "../application/ports.ts";
import type { Recipe } from "../domain/recipe.ts";
import { recipeLines, recipes } from "./db/schema.ts";
import { toQuantity } from "./quantity-mapper.ts";

export const recipeRepository: RecipeRepository = {
  /**
   * 次の版番号。
   *
   * 同じ商品の版を同時に 2 つ登録すると同じ番号を採ってしまうが、
   * (product_id, version) の unique 制約が後勝ちを弾く。レシピ登録は人が行う
   * 低頻度の操作なので、採番のための行ロックまでは持たない。
   */
  async nextVersion(tx: Executor, productId: string): Promise<number> {
    const rows = await tx
      .select({ version: recipes.version })
      .from(recipes)
      .where(eq(recipes.productId, productId))
      .orderBy(desc(recipes.version))
      .limit(1);
    return (rows[0]?.version ?? 0) + 1;
  },

  async insert(tx: Executor, recipe: Recipe): Promise<void> {
    await tx.insert(recipes).values({
      id: recipe.recipeId,
      productId: recipe.productId,
      version: recipe.version,
      yieldAmount: recipe.yieldQuantity.amount,
      yieldUnit: recipe.yieldQuantity.unit,
      registeredAt: recipe.registeredAt,
    });
    await tx.insert(recipeLines).values(
      recipe.lines.map((line) => ({
        recipeId: recipe.recipeId,
        ingredientId: line.ingredientId,
        lineAmount: line.quantity.amount,
        lineUnit: line.quantity.unit,
      })),
    );
  },

  async findById(tx: Executor, recipeId: string): Promise<Recipe | null> {
    const head = await tx.select().from(recipes).where(eq(recipes.id, recipeId)).limit(1);
    const row = head[0];
    if (row === undefined) return null;

    const lines = await tx.select().from(recipeLines).where(eq(recipeLines.recipeId, recipeId));

    return {
      recipeId: row.id,
      productId: row.productId,
      version: row.version,
      yieldQuantity: toQuantity(row.yieldAmount, row.yieldUnit),
      lines: lines.map((line) => ({
        ingredientId: line.ingredientId,
        quantity: toQuantity(line.lineAmount, line.lineUnit),
      })),
      registeredAt: row.registeredAt,
    };
  },
};
