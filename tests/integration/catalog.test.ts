/**
 * catalog の統合テスト。実際の PostgreSQL と catalog ロールで動かす。
 *
 * 単体テスト (src/modules/catalog/**) が業務のルールを見るのに対し、ここで見るのは
 * DB を挟んで初めて確かめられること:
 *   - 価格が履歴として積まれ、上書きされていないこと
 *   - 販売停止で行が消えず、getProduct が停止済みも返すこと
 *   - `catalog.ProductDelisted` が**業務データの更新と同じトランザクション**で
 *     outbox に載り、worker のリレーで購読側の inbox まで届くこと
 *   - 失敗したときに業務データもイベントも残らないこと
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { catalog } from "../../src/modules/catalog/index.ts";
import { moduleDb } from "../../src/shared/db.ts";
import { createEventBus, defineSubscription, relayOnce } from "../../src/shared/event-bus.ts";
import type { EventPayload } from "../../src/shared/events.ts";
import { truncateModule } from "../helpers/db.ts";

const croissant = {
  name: "クロワッサン",
  priceJpy: 280,
  allergens: ["wheat", "milk", "egg"],
} as const;

type OutboxRow = {
  event_name: string;
  payload: EventPayload<"catalog.ProductDelisted">;
  published_at: Date | null;
};

async function outboxRows(): Promise<OutboxRow[]> {
  const result = await moduleDb("catalog").execute<OutboxRow>(
    sql`select event_name, payload, published_at from catalog.outbox order by occurred_at`,
  );
  return [...result.rows];
}

async function priceHistoryOf(productId: string): Promise<{ price_jpy: number }[]> {
  const result = await moduleDb("catalog").execute<{ price_jpy: number }>(
    sql`select price_jpy from catalog.product_prices
         where product_id = ${productId} order by effective_from`,
  );
  return [...result.rows];
}

async function inboxCount(): Promise<number> {
  const result = await moduleDb("sales").execute<{ count: string }>(
    sql`select count(*)::text as count from sales.inbox`,
  );
  return Number(result.rows[0]?.count ?? "0");
}

describe("catalog", () => {
  beforeEach(async () => {
    await truncateModule("catalog");
    // 配送先として sales の inbox を使うので一緒に空にする。
    await truncateModule("sales");
  });

  describe("商品の登録と参照", () => {
    it("登録した商品を getProduct で引ける", async () => {
      const productId = await catalog.registerProduct(croissant);
      const view = await catalog.getProduct(productId);

      expect(view).toEqual({
        productId,
        name: "クロワッサン",
        priceJpy: 280,
        // 表示順に正規化されて保存される
        allergens: ["wheat", "egg", "milk"],
        sellable: true,
      });
    });

    it("存在しない商品は null", async () => {
      expect(await catalog.getProduct("00000000-0000-4000-8000-000000000000")).toBeNull();
    });

    it("アレルゲンなしの商品も登録できる", async () => {
      const productId = await catalog.registerProduct({
        name: "米粉パン",
        priceJpy: 240,
        allergens: [],
      });
      expect((await catalog.getProduct(productId))?.allergens).toEqual([]);
    });

    it("登録ではイベントを出さない", async () => {
      await catalog.registerProduct(croissant);
      expect(await outboxRows()).toEqual([]);
    });
  });

  describe("価格改定", () => {
    it("上書きではなく履歴に積まれる", async () => {
      const productId = await catalog.registerProduct(croissant);
      await catalog.changePrice({ productId, priceJpy: 300 });
      await catalog.changePrice({ productId, priceJpy: 320 });

      // 過去の定価が残っている = 売上の再計算ができる
      expect(await priceHistoryOf(productId)).toEqual([
        { price_jpy: 280 },
        { price_jpy: 300 },
        { price_jpy: 320 },
      ]);
      expect((await catalog.getProduct(productId))?.priceJpy).toBe(320);
    });

    it("同じ値を送り直しても履歴は増えない", async () => {
      const productId = await catalog.registerProduct(croissant);
      await catalog.changePrice({ productId, priceJpy: 280 });

      expect(await priceHistoryOf(productId)).toEqual([{ price_jpy: 280 }]);
    });

    it("価格改定ではイベントを出さない (契約にあるのは販売停止だけ)", async () => {
      const productId = await catalog.registerProduct(croissant);
      await catalog.changePrice({ productId, priceJpy: 300 });
      expect(await outboxRows()).toEqual([]);
    });

    it("不正な価格は履歴を汚さない", async () => {
      const productId = await catalog.registerProduct(croissant);
      await expect(catalog.changePrice({ productId, priceJpy: 0 })).rejects.toThrow(/1 円以上/);
      expect(await priceHistoryOf(productId)).toEqual([{ price_jpy: 280 }]);
    });
  });

  describe("販売停止", () => {
    it("行を消さず sellable = false にする。getProduct は停止済みも返す", async () => {
      const productId = await catalog.registerProduct(croissant);
      await catalog.delistProduct({ productId, reason: "seasonal" });

      const view = await catalog.getProduct(productId);
      expect(view?.sellable).toBe(false);
      // 過去の売上・製造実績から参照されるので、名前も定価も引けたままにする
      expect(view?.name).toBe("クロワッサン");
      expect(view?.priceJpy).toBe(280);
    });

    it("listSellableProducts からは消える", async () => {
      const keep = await catalog.registerProduct({ ...croissant, name: "あんぱん" });
      const drop = await catalog.registerProduct(croissant);
      await catalog.delistProduct({ productId: drop, reason: "discontinued" });

      const listed = await catalog.listSellableProducts();
      expect(listed.map((product) => product.productId)).toEqual([keep]);
    });

    it("業務データの更新と同じトランザクションで outbox に載る", async () => {
      const productId = await catalog.registerProduct(croissant);
      await catalog.delistProduct({ productId, reason: "supply_shortage" });

      const rows = await outboxRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.event_name).toBe("catalog.ProductDelisted");
      expect(rows[0]?.published_at).toBeNull();
      // 運ぶのは事実だけ。名前・価格・アレルゲンは載せない。
      expect(Object.keys(rows[0]?.payload ?? {}).sort()).toEqual([
        "delistedAt",
        "productId",
        "reason",
      ]);
      expect(rows[0]?.payload.productId).toBe(productId);
      expect(rows[0]?.payload.reason).toBe("supply_shortage");
    });

    it("二重の停止は弾き、イベントも業務データも増えない", async () => {
      const productId = await catalog.registerProduct(croissant);
      await catalog.delistProduct({ productId, reason: "discontinued" });

      await expect(catalog.delistProduct({ productId, reason: "other" })).rejects.toThrow(
        /販売停止済み/,
      );

      expect(await outboxRows()).toHaveLength(1);
      // 最初の理由のまま。2回目の "other" で上書きされていない。
      const stored = await moduleDb("catalog").execute<{ delist_reason: string }>(
        sql`select delist_reason from catalog.products where id = ${productId}`,
      );
      expect(stored.rows[0]?.delist_reason).toBe("discontinued");
    });

    it("存在しない商品を停止しようとしてもイベントは出ない", async () => {
      await expect(
        catalog.delistProduct({
          productId: "00000000-0000-4000-8000-000000000000",
          reason: "other",
        }),
      ).rejects.toThrow(/存在しません/);
      expect(await outboxRows()).toEqual([]);
    });

    it("販売停止した商品の価格は改定できない", async () => {
      const productId = await catalog.registerProduct(croissant);
      await catalog.delistProduct({ productId, reason: "seasonal" });

      await expect(catalog.changePrice({ productId, priceJpy: 300 })).rejects.toThrow(
        /販売停止済み/,
      );
      expect(await priceHistoryOf(productId)).toEqual([{ price_jpy: 280 }]);
    });
  });

  describe("販売停止イベントの配送", () => {
    it("outbox から worker のリレーで購読側に届く", async () => {
      const productId = await catalog.registerProduct(croissant);
      await catalog.delistProduct({ productId, reason: "seasonal" });

      // 購読側 (production / sales) はまだ未実装なので、経路の確認用にダミーを置く。
      // 購読側の処理はこのモジュールの担当ではないため、届くことだけを見る。
      const received: EventPayload<"catalog.ProductDelisted">[] = [];
      const bus = createEventBus(
        [
          defineSubscription({
            subscriber: "sales",
            handler: "catalog-integration-probe",
            eventName: "catalog.ProductDelisted",
            handle: async (event) => {
              received.push(event.payload);
            },
          }),
        ],
        moduleDb,
      );

      const delivered = await relayOnce(bus, moduleDb, { modules: ["catalog"] });

      expect(delivered).toBe(1);
      expect(received).toHaveLength(1);
      expect(received[0]?.productId).toBe(productId);
      expect(received[0]?.reason).toBe("seasonal");
      // 購読側の inbox に処理済みとして残り、発行側は配信済みになる
      expect(await inboxCount()).toBe(1);
      expect((await outboxRows())[0]?.published_at).not.toBeNull();
    });

    it("購読側は productId から catalog.getProduct で商品を引き直せる", async () => {
      const productId = await catalog.registerProduct(croissant);
      await catalog.delistProduct({ productId, reason: "discontinued" });

      // イベントには名前も価格も載っていない。購読側は同期で問い合わせる
      // (docs/conventions/events.md「イベントに何を載せるか」)。
      const resolved: (string | null)[] = [];
      const bus = createEventBus(
        [
          defineSubscription({
            subscriber: "sales",
            handler: "catalog-integration-lookup",
            eventName: "catalog.ProductDelisted",
            handle: async (event) => {
              const view = await catalog.getProduct(event.payload.productId);
              resolved.push(view?.name ?? null);
            },
          }),
        ],
        moduleDb,
      );

      await relayOnce(bus, moduleDb, { modules: ["catalog"] });

      // 停止済みでも引けることがここで効く
      expect(resolved).toEqual(["クロワッサン"]);
    });
  });
});
