/**
 * 製造計画の永続化。
 *
 * 計画は営業日ごとに 1 つ。立て直しは明細の置き換えで表す。
 * 明細を消して入れ直すのは、差分更新にすると「消えた行」を追う処理が要り、
 * 置換より複雑になるうえに計画は 1 日数行しかないため。
 */
import { and, eq, gte, inArray } from "drizzle-orm";
import type { Executor } from "../../../shared/tables.ts";
import type { ProductionPlanRepository } from "../application/ports.ts";
import type { BusinessDate } from "../domain/business-date.ts";
import { ProductionValidationError } from "../domain/errors.ts";
import {
  isPlanBasis,
  type ProductionPlan,
  type ProductionPlanItem,
} from "../domain/production-plan.ts";
import { productionPlanItems, productionPlans } from "./db/schema.ts";
import { toQuantity } from "./quantity-mapper.ts";

type PlanRow = { id: string; businessDate: string };

async function loadItems(tx: Executor, planId: string): Promise<readonly ProductionPlanItem[]> {
  const rows = await tx
    .select()
    .from(productionPlanItems)
    .where(eq(productionPlanItems.productionPlanId, planId));

  return rows.map((row) => {
    if (!isPlanBasis(row.basis)) {
      throw new ProductionValidationError(
        `計画 ${planId} に不正な根拠が保存されています: ${row.basis}`,
      );
    }
    return {
      productId: row.productId,
      recipeId: row.recipeId,
      plannedQuantity: toQuantity(row.plannedAmount, row.plannedUnit),
      basis: row.basis,
    };
  });
}

async function toPlan(tx: Executor, row: PlanRow): Promise<ProductionPlan> {
  return {
    productionPlanId: row.id,
    businessDate: row.businessDate,
    items: await loadItems(tx, row.id),
  };
}

export const productionPlanRepository: ProductionPlanRepository = {
  async findById(tx: Executor, productionPlanId: string): Promise<ProductionPlan | null> {
    const rows = await tx
      .select({ id: productionPlans.id, businessDate: productionPlans.businessDate })
      .from(productionPlans)
      .where(eq(productionPlans.id, productionPlanId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toPlan(tx, row);
  },

  async findByBusinessDate(
    tx: Executor,
    businessDate: BusinessDate,
  ): Promise<ProductionPlan | null> {
    const rows = await tx
      .select({ id: productionPlans.id, businessDate: productionPlans.businessDate })
      .from(productionPlans)
      .where(eq(productionPlans.businessDate, businessDate))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toPlan(tx, row);
  },

  async save(tx: Executor, plan: ProductionPlan): Promise<void> {
    await tx
      .insert(productionPlans)
      .values({ id: plan.productionPlanId, businessDate: plan.businessDate })
      .onConflictDoUpdate({
        target: productionPlans.id,
        set: { updatedAt: new Date() },
      });

    await tx
      .delete(productionPlanItems)
      .where(eq(productionPlanItems.productionPlanId, plan.productionPlanId));

    if (plan.items.length === 0) return;

    await tx.insert(productionPlanItems).values(
      plan.items.map((item) => ({
        productionPlanId: plan.productionPlanId,
        productId: item.productId,
        recipeId: item.recipeId,
        plannedAmount: item.plannedQuantity.amount,
        plannedUnit: item.plannedQuantity.unit,
        basis: item.basis,
      })),
    );
  },

  /** 販売停止以降の計画からだけ外す。過去の計画は記録として残す。 */
  async removeProductFrom(
    tx: Executor,
    productId: string,
    fromBusinessDate: BusinessDate,
  ): Promise<number> {
    const future = tx
      .select({ id: productionPlans.id })
      .from(productionPlans)
      .where(gte(productionPlans.businessDate, fromBusinessDate));

    const removed = await tx
      .delete(productionPlanItems)
      .where(
        and(
          eq(productionPlanItems.productId, productId),
          inArray(productionPlanItems.productionPlanId, future),
        ),
      )
      .returning({ productId: productionPlanItems.productId });

    return removed.length;
  },
};
