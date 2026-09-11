/**
 * 数量のドメインテスト。
 *
 * 浮動小数の誤差をそのまま inventory に流さないことと、
 * 製品 (個数) と原材料 (質量/体積) の取り違えを入口で止めることを固定する。
 */
import { describe, expect, it } from "vitest";
import { addQuantity, assertPieces, quantity, roundAmount, scaleQuantity } from "./quantity.ts";

describe("roundAmount", () => {
  it("mg まで丸める", () => {
    expect(roundAmount(1200.00049)).toBe(1200);
    expect(roundAmount(0.1 + 0.2)).toBe(0.3);
  });
});

describe("scaleQuantity", () => {
  it("バッチ数を掛けても単位は変わらない", () => {
    expect(scaleQuantity({ amount: 1200, unit: "g" }, 2)).toEqual({ amount: 2400, unit: "g" });
  });

  it("掛け算の誤差をここで吸収する", () => {
    // 0.1 * 3 は 0.30000000000000004。そのまま numeric に入れない。
    expect(scaleQuantity({ amount: 0.1, unit: "g" }, 3)).toEqual({ amount: 0.3, unit: "g" });
  });
});

describe("addQuantity", () => {
  it("同じ単位なら足せる", () => {
    expect(addQuantity(quantity(100, "g"), quantity(50, "g"))).toEqual(quantity(150, "g"));
  });

  it("単位が違う数量は足せない", () => {
    expect(() => addQuantity(quantity(100, "g"), quantity(1, "piece"))).toThrow(
      "単位の違う数量は足せません",
    );
  });
});

describe("assertPieces", () => {
  it("製品は整数の個数でしか数えない", () => {
    expect(() => assertPieces(quantity(24, "piece"), "個数")).not.toThrow();
    expect(() => assertPieces(quantity(24, "g"), "個数")).toThrow("個数 (piece) で指定");
    expect(() => assertPieces(quantity(2.5, "piece"), "個数")).toThrow("整数である必要");
    expect(() => assertPieces(quantity(0, "piece"), "個数")).toThrow("正の数量");
  });
});
