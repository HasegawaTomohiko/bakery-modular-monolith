/**
 * 製造実績の永続化。実績は書き換えない (焼いた事実は変わらないため)。
 */
import type { Executor } from "../../../shared/tables.ts";
import type { ProductionRunRepository } from "../application/ports.ts";
import type { ProductionRun } from "../domain/production-run.ts";
import { productionRunConsumptions, productionRuns } from "./db/schema.ts";

export const productionRunRepository: ProductionRunRepository = {
  async insert(tx: Executor, run: ProductionRun): Promise<void> {
    await tx.insert(productionRuns).values({
      id: run.productionRunId,
      productionPlanId: run.productionPlanId,
      productId: run.productId,
      recipeId: run.recipeId,
      plannedAmount: run.plannedQuantity.amount,
      producedAmount: run.producedQuantity.amount,
      quantityUnit: run.producedQuantity.unit,
      lotCode: run.lotCode,
      bestBefore: run.bestBefore,
      completedAt: new Date(run.completedAt),
    });

    if (run.consumedIngredients.length === 0) return;

    await tx.insert(productionRunConsumptions).values(
      run.consumedIngredients.map((line) => ({
        productionRunId: run.productionRunId,
        ingredientId: line.ingredientId,
        consumedAmount: line.quantity.amount,
        consumedUnit: line.quantity.unit,
      })),
    );
  },
};
