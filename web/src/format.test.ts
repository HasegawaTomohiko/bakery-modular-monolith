/**
 * 表示の変換。画面の数字の読めなさは、ほとんどここで決まる。
 */
import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatJpy,
  formatNumber,
  formatQuantity,
  shortId,
  todayInJst,
} from "./format.ts";

describe("formatJpy", () => {
  it("桁区切りを入れる", () => {
    expect(formatJpy(9600)).toBe("¥9,600");
    expect(formatJpy(0)).toBe("¥0");
  });
});

describe("formatNumber", () => {
  it("桁区切りを入れる", () => {
    expect(formatNumber(25000)).toBe("25,000");
  });

  it("マイナスもそのまま出す (在庫はマイナスになり得る)", () => {
    expect(formatNumber(-4000)).toBe("-4,000");
  });
});

describe("formatQuantity", () => {
  it("製品は個数で出す", () => {
    expect(formatQuantity({ amount: 40, unit: "piece" })).toBe("40 個");
  });

  it("原材料は単位をそのまま出す (kg に換算しない)", () => {
    expect(formatQuantity({ amount: 25000, unit: "g" })).toBe("25,000 g");
    expect(formatQuantity({ amount: 500, unit: "ml" })).toBe("500 ml");
  });
});

describe("formatDate", () => {
  it("無い日付は — で埋める (嘘の日付を作らない)", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("2026-10-11")).toBe("2026-10-11");
  });
});

describe("formatDateTime", () => {
  it("解釈できない値はそのまま返す", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });
});

describe("shortId", () => {
  it("突き合わせできる程度に切る", () => {
    expect(shortId("affb88ec-ebf1-4a9e-8e45-f62c7305e9a5")).toBe("affb88ec");
  });
});

describe("todayInJst", () => {
  it("JST の暦日を YYYY-MM-DD で返す", () => {
    expect(todayInJst()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
