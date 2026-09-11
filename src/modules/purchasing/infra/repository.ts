/**
 * application/ports.ts の実装 (drizzle 版)。
 *
 * 受け取る `Executor` は必ずユースケースが開いたトランザクション。ここで別の
 * 接続を掴むと outbox と業務データが別トランザクションになってしまう。
 *
 * 数量は numeric 列に入れているので pg からは文字列で返る。境界をまたぐ前に
 * `Quantity` に戻すのがこの層の仕事で、上のレイヤーには文字列を見せない。
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Quantity } from "../../../shared/events.ts";
import type { Executor } from "../../../shared/tables.ts";
import type {
  NewGoodsReceipt,
  NewPurchaseOrder,
  NewSuggestion,
  PurchasingRepository,
  Supplier,
} from "../application/ports.ts";
import { invalid } from "../domain/errors.ts";
import type {
  GoodsReceipt,
  PurchaseOrder,
  PurchaseOrderStatus,
  ReceiptLine,
} from "../domain/purchase-order.ts";
import { roundAmount } from "../domain/quantity.ts";
import type { PurchaseSuggestion, SuggestionStatus } from "../domain/suggestion.ts";
import {
  goodsReceiptLines,
  goodsReceipts,
  purchaseOrderLines,
  purchaseOrders,
  purchaseSuggestions,
  suppliers,
} from "./db/schema.ts";

/** numeric 列は文字列で返る。契約上の単位はここで組み立てる。 */
function toQuantity(amount: string, unit: string): Quantity {
  const parsed = Number(amount);
  if (Number.isNaN(parsed)) {
    throw invalid(`数量が数値として読めません: ${amount}`);
  }
  if (unit !== "g" && unit !== "ml" && unit !== "piece") {
    throw invalid(`契約外の単位が保存されています: ${unit}`);
  }
  return { amount: roundAmount(parsed), unit };
}

/** numeric 列へは文字列で渡す。float を経由させて丸め誤差を持ち込まないため。 */
function toAmountColumn(quantity: Quantity): string {
  return roundAmount(quantity.amount).toFixed(3);
}

function requireId(rows: readonly { readonly id: string }[], what: string): string {
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error(`${what} の挿入結果が空でした`);
  }
  return id;
}

export function createRepository(tx: Executor): PurchasingRepository {
  return {
    async insertSupplier(supplier: Omit<Supplier, "supplierId">): Promise<string> {
      const rows = await tx
        .insert(suppliers)
        .values({ name: supplier.name, leadTimeDays: supplier.leadTimeDays })
        .returning({ id: suppliers.id });
      return requireId(rows, "仕入先");
    },

    async findSupplier(supplierId: string): Promise<Supplier | null> {
      const rows = await tx.select().from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return { supplierId: row.id, name: row.name, leadTimeDays: row.leadTimeDays };
    },

    async insertPurchaseOrder(order: NewPurchaseOrder): Promise<string> {
      const rows = await tx
        .insert(purchaseOrders)
        .values({
          supplierId: order.supplierId,
          status: "placed",
          orderedAt: order.orderedAt,
        })
        .returning({ id: purchaseOrders.id });
      const purchaseOrderId = requireId(rows, "発注");

      await tx.insert(purchaseOrderLines).values(
        order.lines.map((line, index) => ({
          purchaseOrderId,
          ingredientId: line.ingredientId,
          amount: toAmountColumn(line.quantity),
          unit: line.quantity.unit,
          lineNo: index,
        })),
      );

      return purchaseOrderId;
    },

    async findPurchaseOrder(purchaseOrderId: string): Promise<PurchaseOrder | null> {
      const orders = await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, purchaseOrderId))
        .limit(1);
      const order = orders[0];
      if (order === undefined) return null;

      const lines = await tx
        .select()
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId))
        .orderBy(asc(purchaseOrderLines.lineNo));

      return {
        purchaseOrderId: order.id,
        supplierId: order.supplierId,
        status: order.status as PurchaseOrderStatus,
        orderedAt: order.orderedAt.toISOString(),
        lines: lines.map((line) => ({
          ingredientId: line.ingredientId,
          quantity: toQuantity(line.amount, line.unit),
        })),
      };
    },

    async updatePurchaseOrderStatus(
      purchaseOrderId: string,
      status: PurchaseOrderStatus,
    ): Promise<void> {
      await tx.update(purchaseOrders).set({ status }).where(eq(purchaseOrders.id, purchaseOrderId));
    },

    async insertGoodsReceipt(receipt: NewGoodsReceipt): Promise<string> {
      const rows = await tx
        .insert(goodsReceipts)
        .values({
          purchaseOrderId: receipt.purchaseOrderId,
          receivedAt: receipt.receivedAt,
          acceptedAt: null,
        })
        .returning({ id: goodsReceipts.id });
      const goodsReceiptId = requireId(rows, "入荷");

      await tx.insert(goodsReceiptLines).values(
        receipt.lines.map((line, index) => ({
          goodsReceiptId,
          ingredientId: line.ingredientId,
          amount: toAmountColumn(line.quantity),
          unit: line.quantity.unit,
          lotCode: line.lotCode,
          bestBefore: line.bestBefore,
          lineNo: index,
        })),
      );

      return goodsReceiptId;
    },

    async findGoodsReceipt(goodsReceiptId: string): Promise<GoodsReceipt | null> {
      const receipts = await tx
        .select()
        .from(goodsReceipts)
        .where(eq(goodsReceipts.id, goodsReceiptId))
        .limit(1);
      const receipt = receipts[0];
      if (receipt === undefined) return null;

      const lines = await tx
        .select()
        .from(goodsReceiptLines)
        .where(eq(goodsReceiptLines.goodsReceiptId, goodsReceiptId))
        .orderBy(asc(goodsReceiptLines.lineNo));

      const mapped: ReceiptLine[] = lines.map((line) => ({
        ingredientId: line.ingredientId,
        quantity: toQuantity(line.amount, line.unit),
        lotCode: line.lotCode,
        bestBefore: line.bestBefore,
      }));

      return {
        goodsReceiptId: receipt.id,
        purchaseOrderId: receipt.purchaseOrderId,
        receivedAt: receipt.receivedAt.toISOString(),
        acceptedAt: receipt.acceptedAt === null ? null : receipt.acceptedAt.toISOString(),
        lines: mapped,
      };
    },

    async markGoodsReceiptAccepted(goodsReceiptId: string, acceptedAt: Date): Promise<void> {
      await tx
        .update(goodsReceipts)
        .set({ acceptedAt })
        .where(eq(goodsReceipts.id, goodsReceiptId));
    },

    /**
     * 重複提案の防止は部分ユニークインデックス
     * (`purchase_suggestions_open_ingredient_idx`) に任せる。
     *
     * 先に SELECT して無ければ INSERT、という書き方だと、同じ発注点割れが
     * 並行して届いたときに両方 SELECT を通って2件入る。
     * `on conflict do nothing` なら DB が直列化してくれる。
     */
    async insertSuggestionIfNoneOpen(suggestion: NewSuggestion): Promise<string | null> {
      const rows = await tx
        .insert(purchaseSuggestions)
        .values({
          ingredientId: suggestion.ingredientId,
          suggestedAmount: toAmountColumn(suggestion.suggestedQuantity),
          suggestedUnit: suggestion.suggestedQuantity.unit,
          onHandAmount: toAmountColumn(suggestion.onHandAtDetection),
          onHandUnit: suggestion.onHandAtDetection.unit,
          status: "open",
          createdAt: suggestion.createdAt,
        })
        .onConflictDoNothing()
        .returning({ id: purchaseSuggestions.id });

      return rows[0]?.id ?? null;
    },

    async listSuggestions(status: SuggestionStatus): Promise<readonly PurchaseSuggestion[]> {
      const rows = await tx
        .select()
        .from(purchaseSuggestions)
        .where(eq(purchaseSuggestions.status, status))
        .orderBy(asc(purchaseSuggestions.createdAt), asc(purchaseSuggestions.id));

      return rows.map((row) => ({
        suggestionId: row.id,
        ingredientId: row.ingredientId,
        suggestedQuantity: toQuantity(row.suggestedAmount, row.suggestedUnit),
        onHandAtDetection: toQuantity(row.onHandAmount, row.onHandUnit),
        status: row.status as SuggestionStatus,
        createdAt: row.createdAt.toISOString(),
        purchaseOrderId: row.purchaseOrderId,
      }));
    },

    async markSuggestionsOrdered(
      ingredientIds: readonly string[],
      purchaseOrderId: string,
    ): Promise<number> {
      if (ingredientIds.length === 0) return 0;

      const updated = await tx
        .update(purchaseSuggestions)
        .set({ status: "ordered", purchaseOrderId })
        .where(
          and(
            eq(purchaseSuggestions.status, "open"),
            inArray(purchaseSuggestions.ingredientId, [...ingredientIds]),
          ),
        )
        .returning({ id: purchaseSuggestions.id });

      return updated.length;
    },
  };
}
