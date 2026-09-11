import { describe, expect, it } from "vitest";
import { SalesError } from "./errors.ts";
import { pieces, toPieces } from "./quantity.ts";

describe("toPieces", () => {
  it("個数を受け付ける", () => {
    expect(toPieces({ amount: 2, unit: "piece" }, "line")).toBe(2);
  });

  it("g で売ろうとしたら落とす (製品は個数で数える)", () => {
    expect(() => toPieces({ amount: 200, unit: "g" }, "line")).toThrow(SalesError);
  });

  it("小数の個数は受け付けない", () => {
    expect(() => toPieces({ amount: 1.5, unit: "piece" }, "line")).toThrow(/整数/);
  });

  it("0 個・マイナスは受け付けない", () => {
    expect(() => toPieces({ amount: 0, unit: "piece" }, "line")).toThrow(/1 以上/);
    expect(() => toPieces({ amount: -1, unit: "piece" }, "line")).toThrow(/1 以上/);
  });
});

describe("pieces", () => {
  it("契約の Quantity に戻す", () => {
    expect(pieces(3)).toEqual({ amount: 3, unit: "piece" });
  });
});
