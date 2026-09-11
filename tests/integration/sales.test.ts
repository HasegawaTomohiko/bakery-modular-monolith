/**
 * sales の統合テスト。実際の PostgreSQL と sales ロールで動かす。
 *
 * 単体テスト (src/modules/sales/**) が業務のルールを見るのに対し、ここで見るのは
 * DB とモジュール境界を挟んで初めて確かめられること:
 *   - `sales.SaleCompleted` が**業務データの書き込みと同じトランザクション**で
 *     outbox に載り、relay で購読側に届くこと
 *   - 単価が catalog の公開ユースケース (同期の問い合わせ) から取った
 *     **販売時点の価格**として焼き付き、後の価格改定で過去の売上が動かないこと
 *   - `catalog.ProductDelisted` の購読で sales 側の参照コピーが更新され、
 *     停止された商品が売れなくなること
 *   - 予約は受付では売上にならず、引き渡しで初めて売上になること
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { catalog } from "../../src/modules/catalog/index.ts";
import { salesRoutes } from "../../src/modules/sales/http/routes.ts";
import { sales, salesSubscriptions } from "../../src/modules/sales/index.ts";
import { moduleDb } from "../../src/shared/db.ts";
import { createEventBus, defineSubscription, relayOnce } from "../../src/shared/event-bus.ts";
import type { EventPayload } from "../../src/shared/events.ts";
import { publishEvent } from "../../src/shared/outbox.ts";
import { truncateModule } from "../helpers/db.ts";

const croissant = {
  name: "クロワッサン",
  priceJpy: 280,
  allergens: ["wheat", "milk", "egg"],
} as const;

const baguette = { name: "バゲット", priceJpy: 320, allergens: ["wheat"] } as const;

const piece = (amount: number) => ({ amount, unit: "piece" }) as const;

type SaleOutboxRow = {
  event_name: string;
  payload: EventPayload<"sales.SaleCompleted">;
  published_at: Date | null;
};

async function salesOutbox(): Promise<SaleOutboxRow[]> {
  const result = await moduleDb("sales").execute<SaleOutboxRow>(
    sql`select event_name, payload, published_at from sales.outbox order by occurred_at`,
  );
  return [...result.rows];
}

async function saleRows(): Promise<{ id: string; channel: string; business_date: string }[]> {
  const result = await moduleDb("sales").execute<{
    id: string;
    channel: string;
    business_date: string;
  }>(sql`select id, channel, business_date from sales.sales order by sold_at`);
  return [...result.rows];
}

async function countRows(table: string): Promise<number> {
  const result = await moduleDb("sales").execute<{ count: string }>(
    sql`select count(*)::text as count from sales.${sql.identifier(table)}`,
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function inventoryInboxCount(): Promise<number> {
  const result = await moduleDb("inventory").execute<{ count: string }>(
    sql`select count(*)::text as count from inventory.inbox`,
  );
  return Number(result.rows[0]?.count ?? "0");
}

/** catalog が販売停止を出した体で、catalog の outbox に1件積む。 */
async function publishDelisted(productId: string): Promise<void> {
  await moduleDb("catalog").transaction(async (tx) => {
    await publishEvent(tx, "catalog", "catalog.ProductDelisted", {
      productId,
      delistedAt: new Date().toISOString(),
      reason: "supply_shortage",
    });
  });
}

describe("sales", () => {
  beforeEach(async () => {
    await truncateModule("sales");
    // 価格の取得元 (同期の問い合わせ先) と、配送先として使う購読側も空にする。
    await truncateModule("catalog");
    await truncateModule("inventory");
  });

  describe("店頭販売", () => {
    it("販売時点の価格を焼き付け、業務データと同じトランザクションで outbox に載る", async () => {
      const productId = await catalog.registerProduct(croissant);

      const saleId = await sales.recordSale({
        soldAt: "2026-09-11T07:42:00+09:00",
        lines: [{ productId, lotCode: "CRO-20260911-01", quantity: piece(2) }],
      });

      expect(await saleRows()).toEqual([
        { id: saleId, channel: "storefront", business_date: "2026-09-11" },
      ]);

      const rows = await salesOutbox();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.event_name).toBe("sales.SaleCompleted");
      // まだ worker が回っていないので未配信。業務データと一緒に書かれている。
      expect(rows[0]?.published_at).toBeNull();
      expect(rows[0]?.payload).toEqual({
        saleId,
        channel: "storefront",
        soldAt: "2026-09-10T22:42:00.000Z",
        lines: [
          {
            productId,
            // 在庫ではなく「どのロットを売ったか」だけを伝える。出庫は inventory の仕事。
            lotCode: "CRO-20260911-01",
            quantity: { amount: 2, unit: "piece" },
            unitPriceJpy: 280,
          },
        ],
        totalJpy: 560,
      });
    });

    it("catalog の価格改定後も、記録済みの売上は動かない", async () => {
      const productId = await catalog.registerProduct(croissant);
      await sales.recordSale({
        soldAt: "2026-09-11T07:42:00+09:00",
        lines: [{ productId, lotCode: "CRO-1", quantity: piece(2) }],
      });

      await catalog.changePrice({ productId, priceJpy: 400 });

      // 焼き付けた 280 円のまま。catalog の現在価格を引き直していない。
      expect((await sales.getDailySales("2026-09-11")).totalJpy).toBe(560);
    });

    it("catalog が販売停止している商品は売れない (同期の問い合わせで弾く)", async () => {
      const productId = await catalog.registerProduct(croissant);
      await catalog.delistProduct({ productId, reason: "seasonal" });

      await expect(
        sales.recordSale({
          soldAt: "2026-09-11T07:42:00+09:00",
          lines: [{ productId, lotCode: "CRO-1", quantity: piece(1) }],
        }),
      ).rejects.toThrow(/販売停止中/);

      expect(await saleRows()).toEqual([]);
      expect(await salesOutbox()).toEqual([]);
    });

    it("catalog に無い商品は売れない", async () => {
      await expect(
        sales.recordSale({
          soldAt: "2026-09-11T07:42:00+09:00",
          lines: [
            {
              productId: "00000000-0000-4000-8000-000000000000",
              lotCode: "CRO-1",
              quantity: piece(1),
            },
          ],
        }),
      ).rejects.toThrow(/catalog にありません/);
      expect(await salesOutbox()).toEqual([]);
    });

    it("途中で失敗したら、販売もイベントも残らない", async () => {
      const productId = await catalog.registerProduct(croissant);

      // 個数としては妥当だが int4 に収まらない。明細の書き込み (= 販売の書き込みの後)
      // で落ちるので、同じトランザクションなら販売行も outbox も残らないはず。
      await expect(
        sales.recordSale({
          soldAt: "2026-09-11T07:42:00+09:00",
          lines: [{ productId, lotCode: "CRO-1", quantity: piece(3_000_000_000) }],
        }),
      ).rejects.toThrow();

      expect(await saleRows()).toEqual([]);
      expect(await salesOutbox()).toEqual([]);
      expect(await countRows("sale_lines")).toBe(0);
    });
  });

  describe("販売停止の購読 (参照コピー)", () => {
    it("catalog.ProductDelisted を受けて、その商品を売れなくする", async () => {
      const productId = await catalog.registerProduct(croissant);
      const bus = createEventBus([...salesSubscriptions], moduleDb);

      await publishDelisted(productId);
      // catalog の outbox → sales の購読ハンドラ
      expect(await relayOnce(bus, moduleDb, { modules: ["catalog"] })).toBe(1);

      // 参照コピーが更新され、冪等化の記録も残る
      const copy = await moduleDb("sales").execute<{ product_id: string; sellable: boolean }>(
        sql`select product_id, sellable from sales.product_sellability`,
      );
      expect(copy.rows).toEqual([{ product_id: productId, sellable: false }]);
      expect(await countRows("inbox")).toBe(1);

      // catalog 側はまだ販売可のまま = 弾いたのは sales が持つ参照コピー
      expect((await catalog.getProduct(productId))?.sellable).toBe(true);
      await expect(
        sales.recordSale({
          soldAt: "2026-09-11T07:42:00+09:00",
          lines: [{ productId, lotCode: "CRO-1", quantity: piece(1) }],
        }),
      ).rejects.toThrow(/販売停止中/);
      expect(await salesOutbox()).toEqual([]);

      // 新規の予約も受け付けない
      await expect(
        sales.placeReservation({
          customerName: "山田",
          pickupDate: "2026-09-12",
          lines: [{ productId, quantity: piece(1) }],
        }),
      ).rejects.toThrow(/販売停止中/);
    });

    it("同じ販売停止が2回届いても2回処理しない", async () => {
      const productId = await catalog.registerProduct(croissant);
      const bus = createEventBus([...salesSubscriptions], moduleDb);

      await publishDelisted(productId);
      await relayOnce(bus, moduleDb, { modules: ["catalog"] });
      // worker が published 印を付ける前に落ちた状況を作る
      await moduleDb("catalog").execute(sql`update catalog.outbox set published_at = null`);
      await relayOnce(bus, moduleDb, { modules: ["catalog"] });

      expect(await countRows("inbox")).toBe(1);
      expect(await countRows("product_sellability")).toBe(1);
    });
  });

  describe("予約", () => {
    it("受付では売上が立たず、イベントも出ない", async () => {
      const productId = await catalog.registerProduct(croissant);

      const reservationId = await sales.placeReservation({
        customerName: "山田",
        pickupDate: "2026-09-12",
        lines: [{ productId, quantity: piece(3) }],
      });

      expect(await saleRows()).toEqual([]);
      expect(await salesOutbox()).toEqual([]);
      expect(await sales.getDailySales("2026-09-12")).toEqual({
        businessDate: "2026-09-12",
        totalJpy: 0,
        byProduct: [],
      });
      expect(await sales.listReservations("2026-09-12")).toEqual([
        { reservationId, customerName: "山田", pickupDate: "2026-09-12", status: "placed" },
      ]);
    });

    it("引き渡しで初めて売上が立ち、channel=reservation で発行する", async () => {
      const productId = await catalog.registerProduct(croissant);
      const reservationId = await sales.placeReservation({
        customerName: "山田",
        pickupDate: "2026-09-12",
        lines: [{ productId, quantity: piece(3) }],
      });

      const saleId = await sales.fulfillReservation({
        reservationId,
        fulfilledAt: "2026-09-12T08:00:00+09:00",
        // ロットは引き渡しの瞬間に決まる。1つの予約行が2ロットに割れてもよい。
        lines: [
          { productId, lotCode: "CRO-20260912-01", quantity: piece(2) },
          { productId, lotCode: "CRO-20260912-02", quantity: piece(1) },
        ],
      });

      expect(await saleRows()).toEqual([
        { id: saleId, channel: "reservation", business_date: "2026-09-12" },
      ]);
      const rows = await salesOutbox();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.channel).toBe("reservation");
      expect(rows[0]?.payload.totalJpy).toBe(840);
      expect(rows[0]?.payload.lines.map((line) => line.lotCode)).toEqual([
        "CRO-20260912-01",
        "CRO-20260912-02",
      ]);
      expect((await sales.listReservations("2026-09-12"))[0]?.status).toBe("fulfilled");
      expect((await sales.getDailySales("2026-09-12")).totalJpy).toBe(840);
    });

    it("同じ予約を2回引き渡せない (売上の二重計上を防ぐ)", async () => {
      const productId = await catalog.registerProduct(croissant);
      const reservationId = await sales.placeReservation({
        customerName: "山田",
        pickupDate: "2026-09-12",
        lines: [{ productId, quantity: piece(1) }],
      });
      const handover = {
        reservationId,
        fulfilledAt: "2026-09-12T08:00:00+09:00",
        lines: [{ productId, lotCode: "CRO-1", quantity: piece(1) }],
      };

      await sales.fulfillReservation(handover);
      await expect(sales.fulfillReservation(handover)).rejects.toThrow(/fulfilled/);

      expect(await salesOutbox()).toHaveLength(1);
      expect(await saleRows()).toHaveLength(1);
    });

    it("HTTP からキャンセルでき、キャンセル後は引き渡せない", async () => {
      const productId = await catalog.registerProduct(croissant);
      const reservationId = await sales.placeReservation({
        customerName: "山田",
        pickupDate: "2026-09-12",
        lines: [{ productId, quantity: piece(1) }],
      });

      const response = await salesRoutes.request(`/reservations/${reservationId}/cancel`, {
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ reservationId, status: "cancelled" });
      expect((await sales.listReservations("2026-09-12"))[0]?.status).toBe("cancelled");

      const again = await salesRoutes.request(`/reservations/${reservationId}/cancel`, {
        method: "POST",
      });
      expect(again.status).toBe(409);

      await expect(
        sales.fulfillReservation({
          reservationId,
          fulfilledAt: "2026-09-12T08:00:00+09:00",
          lines: [{ productId, lotCode: "CRO-1", quantity: piece(1) }],
        }),
      ).rejects.toThrow(/cancelled/);
      // キャンセルは売上に影響しない (受付を売上にしていないので取り消すものがない)
      expect(await salesOutbox()).toEqual([]);
    });
  });

  describe("日次売上", () => {
    it("商品ごとに積み上げ、引き渡していない予約は含めない", async () => {
      const croissantId = await catalog.registerProduct(croissant);
      const baguetteId = await catalog.registerProduct(baguette);

      await sales.recordSale({
        soldAt: "2026-09-11T07:42:00+09:00",
        lines: [
          { productId: croissantId, lotCode: "CRO-1", quantity: piece(2) },
          { productId: baguetteId, lotCode: "BAG-1", quantity: piece(1) },
        ],
      });
      await sales.recordSale({
        soldAt: "2026-09-11T15:00:00+09:00",
        lines: [{ productId: croissantId, lotCode: "CRO-2", quantity: piece(1) }],
      });
      // JST では 09-12 の朝なので 09-11 には入らない
      await sales.recordSale({
        soldAt: "2026-09-11T22:00:00Z",
        lines: [{ productId: croissantId, lotCode: "CRO-3", quantity: piece(5) }],
      });
      // 受付だけの予約は売上ではない
      await sales.placeReservation({
        customerName: "山田",
        pickupDate: "2026-09-11",
        lines: [{ productId: croissantId, quantity: piece(10) }],
      });

      const daily = await sales.getDailySales("2026-09-11");

      expect(daily.totalJpy).toBe(1160);
      expect(daily.byProduct).toEqual(
        expect.arrayContaining([
          { productId: croissantId, soldQuantity: piece(3), subtotalJpy: 840 },
          { productId: baguetteId, soldQuantity: piece(1), subtotalJpy: 320 },
        ]),
      );
      expect(daily.byProduct).toHaveLength(2);
      expect((await sales.getDailySales("2026-09-12")).totalJpy).toBe(1400);
    });
  });

  describe("配送", () => {
    it("販売確定が relay で購読側に届く", async () => {
      const productId = await catalog.registerProduct(croissant);
      const received: EventPayload<"sales.SaleCompleted">[] = [];
      // 本物の購読側 (inventory / production) はまだ実装中なので、経路だけを確かめる。
      const bus = createEventBus(
        [
          defineSubscription({
            subscriber: "inventory",
            handler: "test-sale-completed",
            eventName: "sales.SaleCompleted",
            handle: async (event) => {
              received.push(event.payload);
            },
          }),
        ],
        moduleDb,
      );

      const saleId = await sales.recordSale({
        soldAt: "2026-09-11T07:42:00+09:00",
        lines: [{ productId, lotCode: "CRO-1", quantity: piece(2) }],
      });

      expect(await relayOnce(bus, moduleDb, { modules: ["sales"] })).toBe(1);

      expect(received.map((payload) => payload.saleId)).toEqual([saleId]);
      expect(received[0]?.lines[0]?.unitPriceJpy).toBe(280);
      expect(await inventoryInboxCount()).toBe(1);
      // 発行側は配信済みになる
      expect((await salesOutbox())[0]?.published_at).not.toBeNull();
    });
  });
});
