/**
 * 需要予測。製造計画の入力。
 *
 * 入力は sales.SaleCompleted を購読して溜めた販売実績だけ。天気も気温も
 * 見ていない。凝ったアルゴリズムより、**根拠を説明できること**を優先している。
 * 「なぜ 30 個なのか」に答えられない予測は、外れたときに直しようがないため、
 * 結果には必ず basis (標本日数・平均販売数・予約数) を添える。
 *
 * ## 曜日差を考慮する理由
 *
 * パン屋の来客は曜日で明確に違う。土日は家族連れで増え、平日の昼は少ない。
 * 全曜日をならした平均を使うと、土曜は毎週足りず、火曜は毎週捨てることになる。
 * そこで**同じ曜日の直近の実績**を標本にする。
 *
 * ただし開店直後や新商品では同曜日の標本が 1 日も無いことがある。曜日差より
 * 標本数が少ないことの方が予測を壊すので、同曜日の標本が 2 日に満たないときは
 * 窓の中の全営業日を使う。
 *
 * ## 丸めを切り上げにする理由
 *
 * 平均 23.4 個なら 24 個焼く。1 個の欠品は「買えなかった客」を生み、その客は
 * 次の来店ごと失われかねない。1 個の廃棄は原材料の原価だけの損失で、金額でいえば
 * 売価より小さい。同点なら多い方に倒す。
 */
import type { Quantity } from "../../../shared/events.ts";
import {
  assertBusinessDate,
  type BusinessDate,
  shiftBusinessDate,
  weekdayOf,
} from "./business-date.ts";
import { quantity } from "./quantity.ts";

/** 標本 1 日分。チャネル (店頭/予約) をまとめた、その営業日に売れた個数。 */
export type SalesSample = {
  readonly businessDate: BusinessDate;
  readonly soldQuantity: number;
};

export type DemandForecast = {
  readonly productId: string;
  readonly businessDate: BusinessDate;
  readonly forecastQuantity: Quantity;
  readonly basis: {
    readonly sampleDays: number;
    readonly averageSoldQuantity: Quantity;
    readonly reservedQuantity: Quantity;
  };
};

/** 標本に使う窓。4 週間あれば同曜日が 4 日入る。これより長いと季節や値段の変化を引きずる。 */
export const FORECAST_WINDOW_DAYS = 28;

/** 同曜日だけで見るために最低限必要な標本日数。 */
export const MIN_WEEKDAY_SAMPLES = 2;

export function forecastDemand(params: {
  readonly productId: string;
  readonly businessDate: BusinessDate;
  /** 対象営業日より前の販売実績。窓の外や未来日が混ざっていてもここで落とす。 */
  readonly samples: readonly SalesSample[];
  /** 確定済みの予約数。焼かないと引き渡せないので予測の下限になる。 */
  readonly reservedQuantity: number;
}): DemandForecast {
  const businessDate = assertBusinessDate(params.businessDate);
  const windowStart = shiftBusinessDate(businessDate, -FORECAST_WINDOW_DAYS);

  // 対象日そのものは含めない。予測を立てる時点ではまだ売れていないため。
  const inWindow = params.samples.filter(
    (sample) => sample.businessDate >= windowStart && sample.businessDate < businessDate,
  );

  const targetWeekday = weekdayOf(businessDate);
  const sameWeekday = inWindow.filter((sample) => weekdayOf(sample.businessDate) === targetWeekday);

  const chosen = sameWeekday.length >= MIN_WEEKDAY_SAMPLES ? sameWeekday : inWindow;
  const total = chosen.reduce((sum, sample) => sum + sample.soldQuantity, 0);
  const average = chosen.length === 0 ? 0 : total / chosen.length;

  // 予約は必ず作る必要があるので下限として効かせる。平均より予約が多い日
  // (団体注文が入った日など) は予約数がそのまま予測になる。
  const forecast = Math.max(Math.ceil(average), Math.ceil(params.reservedQuantity));

  return {
    productId: params.productId,
    businessDate,
    forecastQuantity: quantity(forecast, "piece"),
    basis: {
      sampleDays: chosen.length,
      // 平均は丸めずに返す。切り上げ後の値しか無いと、24 個が「23.4 の切り上げ」
      // なのか「24.0 ちょうど」なのか分からず、予測の癖を検証できない。
      averageSoldQuantity: quantity(average, "piece"),
      reservedQuantity: quantity(params.reservedQuantity, "piece"),
    },
  };
}
