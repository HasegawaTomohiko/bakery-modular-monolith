/**
 * 営業日のドメインテスト。
 *
 * 販売実績の営業日がずれると需要予測の標本が丸ごと 1 日ずれる。
 * 特に日本 (+09:00) は UTC に直すと前日になる時刻が毎朝あるので、そこを固定する。
 */
import { describe, expect, it } from "vitest";
import {
  assertBusinessDate,
  businessDateOf,
  shiftBusinessDate,
  weekdayOf,
} from "./business-date.ts";

describe("businessDateOf", () => {
  it("オフセット付きの時刻から現地日付を取る", () => {
    expect(businessDateOf("2026-09-12T07:42:00+09:00")).toBe("2026-09-12");
  });

  it("UTC に直すと前日になる朝の販売も、その日の営業日として数える", () => {
    // 開店直後の 7:00 (+09:00) は UTC では前日 22:00。UTC の日付を使うと
    // 朝の売上だけが前日に混ざり、予測の標本が狂う。
    expect(businessDateOf("2026-09-12T07:00:00+09:00")).toBe("2026-09-12");
  });

  it("深夜の販売も現地日付のまま", () => {
    expect(businessDateOf("2026-09-12T23:30:00+09:00")).toBe("2026-09-12");
  });

  it("Z 付きの時刻も扱える", () => {
    expect(businessDateOf("2026-09-12T07:42:00Z")).toBe("2026-09-12");
  });

  it("時刻でない文字列は弾く", () => {
    expect(() => businessDateOf("2026-09-12")).toThrow("時刻の形式が不正");
  });
});

describe("assertBusinessDate", () => {
  it("YYYY-MM-DD だけを通す", () => {
    expect(assertBusinessDate("2026-09-12")).toBe("2026-09-12");
    expect(() => assertBusinessDate("2026/09/12")).toThrow("YYYY-MM-DD");
    expect(() => assertBusinessDate("2026-09-12T00:00:00Z")).toThrow("YYYY-MM-DD");
  });
});

describe("shiftBusinessDate", () => {
  it("月をまたいで前後に動かせる", () => {
    expect(shiftBusinessDate("2026-09-01", -1)).toBe("2026-08-31");
    expect(shiftBusinessDate("2026-08-31", 1)).toBe("2026-09-01");
  });

  it("予測の窓 (28 日) 分さかのぼれる", () => {
    expect(shiftBusinessDate("2026-09-19", -28)).toBe("2026-08-22");
  });

  it("うるう日をまたいでもずれない", () => {
    expect(shiftBusinessDate("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftBusinessDate("2028-02-29", 1)).toBe("2028-03-01");
  });
});

describe("weekdayOf", () => {
  it("曜日を返す (0 = 日曜)", () => {
    expect(weekdayOf("2026-09-19")).toBe(6); // 土
    expect(weekdayOf("2026-09-20")).toBe(0); // 日
    expect(weekdayOf("2026-09-21")).toBe(1); // 月
  });

  it("7 日ごとに同じ曜日になる", () => {
    expect(weekdayOf("2026-09-05")).toBe(weekdayOf("2026-09-12"));
  });
});
