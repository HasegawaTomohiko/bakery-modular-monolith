/**
 * 需要予測のドメインテスト。
 *
 * 「今日何を何個焼くか」の入力になる値なので、数字そのものと同じくらい
 * **basis (根拠) が結果と整合していること**を固定する。根拠が合っていない予測は
 * 外れたときに直しようがない。
 */
import { describe, expect, it } from "vitest";
import { forecastDemand, type SalesSample } from "./demand-forecast.ts";

const PRODUCT = "11111111-1111-4111-8111-111111111111";

const sample = (businessDate: string, soldQuantity: number): SalesSample => ({
  businessDate,
  soldQuantity,
});

/** 2026-09-19 は土曜。9/5, 9/12 も土曜。 */
const SATURDAY = "2026-09-19";

describe("forecastDemand", () => {
  it("同じ曜日の標本が 2 日以上あれば同曜日だけで見る", () => {
    const forecast = forecastDemand({
      productId: PRODUCT,
      businessDate: SATURDAY,
      samples: [
        sample("2026-09-05", 40), // 土
        sample("2026-09-12", 44), // 土
        sample("2026-09-08", 12), // 火
        sample("2026-09-09", 10), // 水
      ],
      reservedQuantity: 0,
    });

    // 全曜日平均 26.5 ではなく、土曜だけの 42。
    expect(forecast.basis.sampleDays).toBe(2);
    expect(forecast.basis.averageSoldQuantity.amount).toBe(42);
    expect(forecast.forecastQuantity.amount).toBe(42);
  });

  it("同じ曜日が 1 日しか無ければ全曜日で見る (標本数を優先)", () => {
    const forecast = forecastDemand({
      productId: PRODUCT,
      businessDate: SATURDAY,
      samples: [sample("2026-09-12", 40), sample("2026-09-08", 12), sample("2026-09-09", 14)],
      reservedQuantity: 0,
    });

    expect(forecast.basis.sampleDays).toBe(3);
    expect(forecast.basis.averageSoldQuantity.amount).toBe(22);
    expect(forecast.forecastQuantity.amount).toBe(22);
  });

  it("平均は切り上げる (1 個の欠品は 1 個の廃棄より痛い)", () => {
    const forecast = forecastDemand({
      productId: PRODUCT,
      businessDate: SATURDAY,
      samples: [sample("2026-09-08", 11), sample("2026-09-09", 12)],
      reservedQuantity: 0,
    });

    // 平均は丸めずに残し、焼く数だけ切り上げる。予測の癖を後から検証できるように。
    expect(forecast.basis.averageSoldQuantity.amount).toBe(11.5);
    expect(forecast.forecastQuantity.amount).toBe(12);
  });

  it("確定済みの予約は下限として効く", () => {
    const forecast = forecastDemand({
      productId: PRODUCT,
      businessDate: SATURDAY,
      samples: [sample("2026-09-05", 10), sample("2026-09-12", 10)],
      reservedQuantity: 30,
    });

    expect(forecast.forecastQuantity.amount).toBe(30);
    // 根拠は「平均 10 個だが予約が 30 個ある」と読める形で残る。
    expect(forecast.basis.averageSoldQuantity.amount).toBe(10);
    expect(forecast.basis.reservedQuantity.amount).toBe(30);
  });

  it("平均が予約を上回るならそのまま平均を使う", () => {
    const forecast = forecastDemand({
      productId: PRODUCT,
      businessDate: SATURDAY,
      samples: [sample("2026-09-05", 40), sample("2026-09-12", 40)],
      reservedQuantity: 5,
    });

    expect(forecast.forecastQuantity.amount).toBe(40);
  });

  it("窓 (28 日) の外の実績は標本にしない", () => {
    const forecast = forecastDemand({
      productId: PRODUCT,
      businessDate: SATURDAY,
      samples: [
        sample("2026-08-01", 100), // 28 日より前。季節も値段も違いうる
        sample("2026-09-12", 20),
        sample("2026-09-11", 18),
      ],
      reservedQuantity: 0,
    });

    expect(forecast.basis.sampleDays).toBe(2);
    expect(forecast.basis.averageSoldQuantity.amount).toBe(19);
  });

  it("対象営業日そのものの販売は標本に入れない", () => {
    // 予測を立てる時点ではまだ売れていない。入れると当日の実績で当日を予測してしまう。
    const forecast = forecastDemand({
      productId: PRODUCT,
      businessDate: SATURDAY,
      samples: [sample(SATURDAY, 99), sample("2026-09-11", 10), sample("2026-09-10", 12)],
      reservedQuantity: 0,
    });

    expect(forecast.basis.sampleDays).toBe(2);
    expect(forecast.basis.averageSoldQuantity.amount).toBe(11);
  });

  it("標本も予約も無ければ 0 個。根拠にも標本 0 日と出る", () => {
    const forecast = forecastDemand({
      productId: PRODUCT,
      businessDate: SATURDAY,
      samples: [],
      reservedQuantity: 0,
    });

    expect(forecast.forecastQuantity.amount).toBe(0);
    expect(forecast.basis.sampleDays).toBe(0);
    expect(forecast.basis.averageSoldQuantity.amount).toBe(0);
  });

  it("実績が無くても予約があれば予約分は焼く", () => {
    const forecast = forecastDemand({
      productId: PRODUCT,
      businessDate: SATURDAY,
      samples: [],
      reservedQuantity: 12,
    });

    expect(forecast.forecastQuantity.amount).toBe(12);
    expect(forecast.basis.sampleDays).toBe(0);
  });

  it("数量は必ず個数で返す", () => {
    const forecast = forecastDemand({
      productId: PRODUCT,
      businessDate: SATURDAY,
      samples: [sample("2026-09-12", 20)],
      reservedQuantity: 0,
    });

    expect(forecast.forecastQuantity.unit).toBe("piece");
    expect(forecast.basis.averageSoldQuantity.unit).toBe("piece");
    expect(forecast.basis.reservedQuantity.unit).toBe("piece");
  });
});
