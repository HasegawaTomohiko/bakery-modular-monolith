import { describe, expect, it } from "vitest";
import { businessDateOf } from "./business-date.ts";

/**
 * 営業日は JST の暦日。サーバの TZ に依存しないことと、日跨ぎの境界を固定する。
 */
describe("businessDateOf", () => {
  it("JST の暦日で切る", () => {
    expect(businessDateOf(new Date("2026-09-11T07:42:00+09:00"))).toBe("2026-09-11");
  });

  it("UTC で日付が前日でも JST の日付になる", () => {
    // 09:00 JST = 00:00 UTC。UTC 基準だと同じ日だが、22:00 UTC は JST では翌日。
    expect(businessDateOf(new Date("2026-09-11T22:00:00Z"))).toBe("2026-09-12");
  });

  it("JST 0 時ちょうどはその日に含まれる", () => {
    expect(businessDateOf(new Date("2026-09-11T00:00:00+09:00"))).toBe("2026-09-11");
  });

  it("JST 23:59:59 は同じ日、24 時ちょうどは翌日", () => {
    expect(businessDateOf(new Date("2026-09-11T23:59:59+09:00"))).toBe("2026-09-11");
    expect(businessDateOf(new Date("2026-09-12T00:00:00+09:00"))).toBe("2026-09-12");
  });
});
