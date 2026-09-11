/**
 * 画面向けの問い合わせ。
 *
 * 読むのは readmodel スキーマだけ。ここでの JOIN は**同じスキーマの中**なので
 * 境界をまたがない (またぐ JOIN はそもそも権限が無くて書けない)。
 *
 * 投影済みの表を読むだけで、業務ロジックは持たない。唯一ここで計算するのは
 * 「製造数 − 販売数 = 売れ残り」と廃棄率で、これは元の数字から一意に決まる表示計算。
 */
import { and, asc, eq } from "drizzle-orm";
import { moduleDb } from "../shared/db.ts";
import type { Quantity } from "../shared/events.ts";
import {
  dailyIngredientFlow,
  dailyLotSummary,
  dailyProductSummary,
  delistedProducts,
} from "./db/schema.ts";

export type DelistReason = "discontinued" | "seasonal" | "supply_shortage" | "other";

/** 商品別の1日。売上と廃棄ロスが同じ行に並ぶ。 */
export type DailyProductRow = {
  readonly productId: string;
  readonly producedPieces: number;
  readonly soldPieces: number;
  /** 製造数 − 販売数。製品は当日限りなので、これがそのまま廃棄ロス。 */
  readonly leftoverPieces: number;
  readonly salesJpy: number;
  /** catalog.ProductDelisted を受けた商品。過去の実績は残るので消さずに印を付ける。 */
  readonly delisted: boolean;
  readonly delistReason: DelistReason | null;
};

/** ロット別の1日。廃棄は商品ではなくロット単位で起きる。 */
export type DailyLotRow = {
  readonly lotCode: string;
  readonly productId: string;
  /** 製造完了がまだ届いていないロット (先に売れた) は null。 */
  readonly bestBefore: string | null;
  readonly producedPieces: number;
  readonly soldPieces: number;
  readonly leftoverPieces: number;
  readonly salesJpy: number;
};

/** 原材料の1日の動き。残高ではなく「どれだけ動いたか」。 */
export type DailyIngredientRow = {
  readonly ingredientId: string;
  readonly received: Quantity;
  readonly consumed: Quantity;
  /** 当日発注点を割ったか。割ったときの数字も添える。 */
  readonly reorderBreach: {
    readonly onHand: Quantity;
    readonly reorderPoint: Quantity;
    readonly suggestedOrderQuantity: Quantity;
    readonly detectedAt: string;
  } | null;
};

export type DailyTotals = {
  readonly producedPieces: number;
  readonly soldPieces: number;
  readonly leftoverPieces: number;
  readonly salesJpy: number;
  /** 売れ残り ÷ 製造数 (%)。製造計画の良し悪しはここに出る。 */
  readonly wasteRatePercent: number;
};

export type DailyDashboard = {
  readonly businessDate: string;
  readonly totals: DailyTotals;
  readonly products: readonly DailyProductRow[];
  readonly lots: readonly DailyLotRow[];
  readonly ingredients: readonly DailyIngredientRow[];
};

function quantity(amount: string | null, unit: string): Quantity {
  // numeric 列は文字列で返る。単位は投影時にイベントから写したものを使う。
  return { amount: Number(amount ?? "0"), unit: toUnit(unit) };
}

function toUnit(unit: string): Quantity["unit"] {
  return unit === "ml" || unit === "piece" ? unit : "g";
}

function toDelistReason(reason: string | null): DelistReason | null {
  switch (reason) {
    case "discontinued":
    case "seasonal":
    case "supply_shortage":
    case "other":
      return reason;
    default:
      return null;
  }
}

/**
 * 「今日の在庫と販売状況」。
 *
 * 商品別・ロット別・原材料の3面と合計を1回で返す。画面が3回問い合わせて
 * 別々の時点の数字を並べると、合計が合わない画面になるため。
 */
export async function getDailyDashboard(businessDate: string): Promise<DailyDashboard> {
  const db = moduleDb("readmodel");

  // 販売停止は商品に紐づく状態なので、日次の行に左外部結合で重ねる。
  // readmodel スキーマ内の JOIN なので境界はまたがない。
  const productRows = await db
    .select({
      productId: dailyProductSummary.productId,
      producedPieces: dailyProductSummary.producedPieces,
      soldPieces: dailyProductSummary.soldPieces,
      salesJpy: dailyProductSummary.salesJpy,
      delistReason: delistedProducts.reason,
    })
    .from(dailyProductSummary)
    .leftJoin(delistedProducts, eq(delistedProducts.productId, dailyProductSummary.productId))
    .where(eq(dailyProductSummary.businessDate, businessDate))
    .orderBy(asc(dailyProductSummary.productId));

  const products: DailyProductRow[] = productRows.map((row) => ({
    productId: row.productId,
    producedPieces: row.producedPieces,
    soldPieces: row.soldPieces,
    // 前日のロットが売れた場合などにマイナスになり得る。丸めずそのまま出す。
    // 「数字が合わない」ことが見えるのが参照モデルの価値なので。
    leftoverPieces: row.producedPieces - row.soldPieces,
    salesJpy: row.salesJpy,
    delisted: row.delistReason !== null,
    delistReason: toDelistReason(row.delistReason),
  }));

  const lotRows = await db
    .select()
    .from(dailyLotSummary)
    .where(eq(dailyLotSummary.businessDate, businessDate))
    .orderBy(asc(dailyLotSummary.lotCode));

  const lots: DailyLotRow[] = lotRows.map((row) => ({
    lotCode: row.lotCode,
    productId: row.productId,
    bestBefore: row.bestBefore,
    producedPieces: row.producedPieces,
    soldPieces: row.soldPieces,
    leftoverPieces: row.producedPieces - row.soldPieces,
    salesJpy: row.salesJpy,
  }));

  const ingredientRows = await db
    .select()
    .from(dailyIngredientFlow)
    .where(eq(dailyIngredientFlow.businessDate, businessDate))
    .orderBy(asc(dailyIngredientFlow.ingredientId));

  const ingredients: DailyIngredientRow[] = ingredientRows.map((row) => ({
    ingredientId: row.ingredientId,
    received: quantity(row.receivedAmount, row.unit),
    consumed: quantity(row.consumedAmount, row.unit),
    reorderBreach:
      row.reorderBreached && row.breachDetectedAt !== null
        ? {
            onHand: quantity(row.breachOnHandAmount, row.unit),
            reorderPoint: quantity(row.breachReorderPointAmount, row.unit),
            suggestedOrderQuantity: quantity(row.breachSuggestedAmount, row.unit),
            detectedAt: row.breachDetectedAt.toISOString(),
          }
        : null,
  }));

  return {
    businessDate,
    totals: totalsOf(products),
    products,
    lots,
    ingredients,
  };
}

/** 1原材料の当日の動きだけが欲しいとき。 */
export async function getDailyIngredientFlow(
  businessDate: string,
  ingredientId: string,
): Promise<DailyIngredientRow | null> {
  const rows = await moduleDb("readmodel")
    .select()
    .from(dailyIngredientFlow)
    .where(
      and(
        eq(dailyIngredientFlow.businessDate, businessDate),
        eq(dailyIngredientFlow.ingredientId, ingredientId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    ingredientId: row.ingredientId,
    received: quantity(row.receivedAmount, row.unit),
    consumed: quantity(row.consumedAmount, row.unit),
    reorderBreach:
      row.reorderBreached && row.breachDetectedAt !== null
        ? {
            onHand: quantity(row.breachOnHandAmount, row.unit),
            reorderPoint: quantity(row.breachReorderPointAmount, row.unit),
            suggestedOrderQuantity: quantity(row.breachSuggestedAmount, row.unit),
            detectedAt: row.breachDetectedAt.toISOString(),
          }
        : null,
  };
}

/**
 * 合計と廃棄率。
 *
 * 廃棄率を出すのは、売上だけ見ていると「たくさん焼けば売上は増える」という
 * 誤った読み方になるため。パン屋のコアは売上と廃棄ロスを分ける製造計画なので、
 * 両方を同じ画面に出す。
 */
export function totalsOf(products: readonly DailyProductRow[]): DailyTotals {
  const producedPieces = products.reduce((sum, row) => sum + row.producedPieces, 0);
  const soldPieces = products.reduce((sum, row) => sum + row.soldPieces, 0);
  const salesJpy = products.reduce((sum, row) => sum + row.salesJpy, 0);
  const leftoverPieces = producedPieces - soldPieces;

  return {
    producedPieces,
    soldPieces,
    leftoverPieces,
    salesJpy,
    // 小数第1位まで。0 除算は「焼いていない日」なので 0% とする。
    wasteRatePercent:
      producedPieces === 0 ? 0 : Math.round((leftoverPieces / producedPieces) * 1000) / 10,
  };
}
