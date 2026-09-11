/**
 * 販売実績の永続化。sales.SaleCompleted を購読して積み上げたもの。
 *
 * sales のテーブルは見に行けないので、予測に必要な分だけをこちらに持つ。
 * 保持するのは (営業日, 商品, チャネル) ごとの個数だけで、金額も客も持たない。
 * それらは sales の関心事であり、production が持つと二重管理になるため。
 */
import { and, between, eq, sql } from "drizzle-orm";
import type { Executor } from "../../../shared/tables.ts";
import type { SalesResultEntry, SalesResultRepository } from "../application/ports.ts";
import type { BusinessDate } from "../domain/business-date.ts";
import type { SalesSample } from "../domain/demand-forecast.ts";
import { salesResults } from "./db/schema.ts";

export const salesResultRepository: SalesResultRepository = {
  /**
   * 加算する。配信は at-least-once だが、二重加算は inbox が防ぐ
   * (ハンドラの実行と処理済み記録が同じトランザクションのため)。
   */
  async add(tx: Executor, entry: SalesResultEntry): Promise<void> {
    await tx
      .insert(salesResults)
      .values({
        businessDate: entry.businessDate,
        productId: entry.productId,
        channel: entry.channel,
        soldAmount: entry.soldQuantity,
        quantityUnit: "piece",
      })
      .onConflictDoUpdate({
        target: [salesResults.businessDate, salesResults.productId, salesResults.channel],
        set: {
          soldAmount: sql`${salesResults.soldAmount} + ${entry.soldQuantity}`,
          updatedAt: new Date(),
        },
      });
  },

  /** 営業日ごとの販売数。チャネルはまとめる (予測は「その日何個売れたか」で見る)。 */
  async listDailySales(
    tx: Executor,
    productId: string,
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<readonly SalesSample[]> {
    const rows = await tx
      .select({
        businessDate: salesResults.businessDate,
        soldQuantity: sql<number>`sum(${salesResults.soldAmount})::double precision`,
      })
      .from(salesResults)
      .where(
        and(eq(salesResults.productId, productId), between(salesResults.businessDate, from, to)),
      )
      .groupBy(salesResults.businessDate)
      .orderBy(salesResults.businessDate);

    return rows.map((row) => ({
      businessDate: row.businessDate,
      soldQuantity: Number(row.soldQuantity),
    }));
  },

  async reservedQuantity(
    tx: Executor,
    productId: string,
    businessDate: BusinessDate,
  ): Promise<number> {
    const rows = await tx
      .select({ soldAmount: salesResults.soldAmount })
      .from(salesResults)
      .where(
        and(
          eq(salesResults.productId, productId),
          eq(salesResults.businessDate, businessDate),
          eq(salesResults.channel, "reservation"),
        ),
      )
      .limit(1);
    return rows[0]?.soldAmount ?? 0;
  },
};
