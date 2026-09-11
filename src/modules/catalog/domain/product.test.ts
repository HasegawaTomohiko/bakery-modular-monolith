/**
 * ドメインの単体テスト。DB も HTTP も使わない。
 */
import { describe, expect, it } from "vitest";
// 契約 (公開面) と domain の型がずれていないことを型で固定する。
import type { Allergen as ContractAllergen, ProductView as ContractProductView } from "../index.ts";
import type { Allergen } from "./allergen.ts";
import { ALLERGENS, normalizeAllergens, parseAllergens } from "./allergen.ts";
import { InvalidProductError } from "./errors.ts";
import type { ProductView } from "./product.ts";
import {
  currentPrice,
  normalizeProductName,
  priceAsOf,
  registerProduct,
  toProductView,
  validatePriceJpy,
} from "./product.ts";

// --- 契約との一致 ----------------------------------------------------------

/** 双方向に代入できる = 同じ型。片方向だと部分集合を見逃す。 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const allergenMatchesContract: MutuallyAssignable<Allergen, ContractAllergen> = true;
const viewMatchesContract: MutuallyAssignable<ProductView, ContractProductView> = true;

describe("契約との一致", () => {
  it("domain の Allergen と ProductView が index.ts の公開型と一致する", () => {
    // 型が食い違うとこのファイルはコンパイルできない。実行時の assert は形式的なもの。
    expect(allergenMatchesContract).toBe(true);
    expect(viewMatchesContract).toBe(true);
    expect(ALLERGENS).toHaveLength(8);
  });
});

// --- アレルゲン ------------------------------------------------------------

describe("アレルゲン", () => {
  it("重複を除き、表示順に並べ替える", () => {
    expect(normalizeAllergens(["milk", "wheat", "egg", "wheat"])).toEqual(["wheat", "egg", "milk"]);
  });

  it("該当なしは空配列で表す", () => {
    expect(normalizeAllergens([])).toEqual([]);
  });

  it("保存済みの未知の値は表示事故になるので落とす", () => {
    expect(() => parseAllergens(["wheat", "unicorn"])).toThrow(/未知のアレルゲン/);
  });
});

// --- 商品名 ----------------------------------------------------------------

describe("商品名", () => {
  it("前後の空白と連続空白を潰す", () => {
    expect(normalizeProductName("  クロワッサン  ")).toBe("クロワッサン");
    expect(normalizeProductName("バター   ロール")).toBe("バター ロール");
  });

  it("空の名前は登録できない", () => {
    expect(() => normalizeProductName("   ")).toThrow(InvalidProductError);
  });

  it("長すぎる名前は登録できない", () => {
    expect(() => normalizeProductName("あ".repeat(101))).toThrow(/長すぎます/);
  });
});

// --- 価格 ------------------------------------------------------------------

describe("価格", () => {
  it("日本円は整数", () => {
    expect(validatePriceJpy(280)).toBe(280);
    expect(() => validatePriceJpy(280.5)).toThrow(/整数/);
  });

  it("0 円以下は販売価格にならない", () => {
    expect(() => validatePriceJpy(0)).toThrow(/1 円以上/);
    expect(() => validatePriceJpy(-1)).toThrow(/1 円以上/);
  });
});

// --- 価格履歴 --------------------------------------------------------------

describe("価格履歴", () => {
  const history = [
    { priceJpy: 260, effectiveFrom: new Date("2026-01-01T00:00:00Z") },
    { priceJpy: 280, effectiveFrom: new Date("2026-04-01T00:00:00Z") },
    { priceJpy: 300, effectiveFrom: new Date("2026-09-01T00:00:00Z") },
  ];

  it("その時点で有効だった定価を選ぶ (売上の再計算)", () => {
    expect(priceAsOf(history, new Date("2026-02-15T00:00:00Z"))?.priceJpy).toBe(260);
    expect(priceAsOf(history, new Date("2026-05-15T00:00:00Z"))?.priceJpy).toBe(280);
    expect(priceAsOf(history, new Date("2026-09-10T00:00:00Z"))?.priceJpy).toBe(300);
  });

  it("適用開始と同じ時刻はその価格が有効", () => {
    expect(priceAsOf(history, new Date("2026-04-01T00:00:00Z"))?.priceJpy).toBe(280);
  });

  it("最初の価格より前は答えが無い", () => {
    expect(priceAsOf(history, new Date("2025-12-31T00:00:00Z"))).toBeNull();
  });

  it("履歴の並び順に依存しない", () => {
    const shuffled = [history[2], history[0], history[1]].filter((r) => r !== undefined);
    expect(priceAsOf(shuffled, new Date("2026-05-15T00:00:00Z"))?.priceJpy).toBe(280);
  });

  it("価格履歴が無い商品は現在価格を出せない", () => {
    expect(() => currentPrice([])).toThrow(InvalidProductError);
  });
});

// --- 商品 ------------------------------------------------------------------

describe("商品", () => {
  const registeredAt = new Date("2026-09-11T00:00:00Z");

  it("登録直後は販売可で、停止の情報を持たない", () => {
    const product = registerProduct({
      productId: "p1",
      name: " クロワッサン ",
      allergens: ["milk", "wheat"],
      registeredAt,
    });

    expect(product.name).toBe("クロワッサン");
    expect(product.allergens).toEqual(["wheat", "milk"]);
    expect(product.sellable).toBe(true);
    expect(product.delistedAt).toBeNull();
    expect(product.delistReason).toBeNull();
  });

  it("公開する形には現在の定価が入る", () => {
    const product = registerProduct({
      productId: "p1",
      name: "クロワッサン",
      allergens: ["wheat"],
      registeredAt,
    });
    const view = toProductView(product, [
      { priceJpy: 260, effectiveFrom: new Date("2026-01-01T00:00:00Z") },
      { priceJpy: 280, effectiveFrom: new Date("2026-04-01T00:00:00Z") },
    ]);

    expect(view).toEqual({
      productId: "p1",
      name: "クロワッサン",
      priceJpy: 280,
      allergens: ["wheat"],
      sellable: true,
    });
  });
});
