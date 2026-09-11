import { describe, expect, it } from "vitest";
import { businessDateOf } from "./business-date.ts";

describe("businessDateOf", () => {
  it("オフセット付きの時刻を JST の暦日に落とす", () => {
    // production はこの書き方で発行する (入力の文字列をそのまま運ぶ)。
    expect(businessDateOf("2026-09-11T07:30:00+09:00")).toBe("2026-09-11");
  });

  it("UTC で書かれた時刻も同じ営業日になる", () => {
    // sales / purchasing / inventory は toISOString() で UTC にして発行する。
    // 朝 7 時の販売は前日 22:00Z。文字列の日付部分を採ると前日に寄ってしまう。
    expect(businessDateOf("2026-09-11T22:00:00.000Z")).toBe("2026-09-12");
  });

  it("JST の日付が変わる瞬間をまたぐ", () => {
    expect(businessDateOf("2026-09-11T14:59:59.000Z")).toBe("2026-09-11");
    expect(businessDateOf("2026-09-11T15:00:00.000Z")).toBe("2026-09-12");
  });

  it("解釈できない値でも例外を投げない (配送を止めないため)", () => {
    expect(businessDateOf("2026-09-11")).toBe("2026-09-11");
    expect(businessDateOf("こわれた値")).toBe("こわれた値");
  });
});
