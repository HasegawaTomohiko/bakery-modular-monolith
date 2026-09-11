/**
 * ユースケースの単体テスト。DB を使わない (CatalogStore を in-memory で差す)。
 *
 * ここで見るのは業務のルールと**トランザクション境界の使われ方**。
 * 実際に PostgreSQL のトランザクションが効くかは統合テスト
 * (tests/integration/catalog.test.ts) の担当。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { EventName, EventPayload } from "../../../shared/events.ts";
import { ProductNotFoundError, ProductNotSellableError } from "../domain/errors.ts";
import type { PriceRecord, Product, ProductId } from "../domain/product.ts";
import type { CatalogContext, CatalogStore, CatalogTransaction } from "./store.ts";
import {
  changePrice,
  delistProduct,
  getProduct,
  listSellableProducts,
  registerProduct,
} from "./use-cases.ts";

type PublishedEvent = { readonly name: EventName; readonly payload: unknown };

/**
 * in-memory の CatalogStore。
 *
 * `transaction` は例外が出たら変更を巻き戻す。「イベントだけ残る」「業務データだけ残る」
 * を検出するために、コミットされた状態と作業中の状態を分けている。
 */
function createFakeStore() {
  let products = new Map<ProductId, Product>();
  let prices = new Map<ProductId, PriceRecord[]>();
  let published: PublishedEvent[] = [];

  const store: CatalogStore = {
    async transaction(run) {
      // スナップショット。ロールバックはここに戻すだけ。
      const productsBefore = new Map(products);
      const pricesBefore = new Map([...prices].map(([id, list]) => [id, [...list]] as const));
      const publishedBefore = [...published];

      const tx: CatalogTransaction = {
        async insertProduct(product, initialPrice) {
          products.set(product.productId, product);
          prices.set(product.productId, [initialPrice]);
        },
        async findProduct(productId) {
          const product = products.get(productId);
          if (product === undefined) return null;
          return { product, prices: prices.get(productId) ?? [] };
        },
        async listSellable() {
          return [...products.values()]
            .filter((product) => product.sellable)
            .map((product) => ({ product, prices: prices.get(product.productId) ?? [] }));
        },
        async appendPrice(productId, price) {
          prices.set(productId, [...(prices.get(productId) ?? []), price]);
        },
        async markDelisted(productId, reason, delistedAt) {
          const product = products.get(productId);
          if (product === undefined || !product.sellable) return false;
          products.set(productId, {
            ...product,
            sellable: false,
            delistedAt,
            delistReason: reason as Product["delistReason"],
          });
          return true;
        },
        async publish<N extends EventName>(name: N, payload: EventPayload<N>) {
          published.push({ name, payload });
        },
      };

      try {
        return await run(tx);
      } catch (error) {
        products = productsBefore;
        prices = new Map([...pricesBefore].map(([id, list]) => [id, [...list]]));
        published = publishedBefore;
        throw error;
      }
    },
  };

  return {
    store,
    publishedEvents: () => published,
    rawProduct: (id: ProductId) => products.get(id) ?? null,
    priceHistory: (id: ProductId) => prices.get(id) ?? [],
  };
}

let fake: ReturnType<typeof createFakeStore>;
let context: CatalogContext;
let clock: Date;
let idCounter: number;

beforeEach(() => {
  fake = createFakeStore();
  clock = new Date("2026-09-11T00:00:00.000Z");
  idCounter = 0;
  context = {
    store: fake.store,
    now: () => clock,
    newProductId: () => {
      idCounter += 1;
      return `product-${idCounter}`;
    },
  };
});

const croissant = { name: "クロワッサン", priceJpy: 280, allergens: ["wheat", "milk"] } as const;

describe("registerProduct", () => {
  it("登録直後は販売可で、初回価格が履歴の1行目になる", async () => {
    const productId = await registerProduct(context, croissant);

    expect(fake.rawProduct(productId)?.sellable).toBe(true);
    expect(fake.priceHistory(productId)).toEqual([{ priceJpy: 280, effectiveFrom: clock }]);
  });

  it("アレルゲンは正規化して保存する", async () => {
    const productId = await registerProduct(context, {
      name: "クロワッサン",
      priceJpy: 280,
      allergens: ["milk", "wheat", "milk"],
    });
    expect(fake.rawProduct(productId)?.allergens).toEqual(["wheat", "milk"]);
  });

  it("アレルゲンなしの商品も登録できる (該当なしは空配列)", async () => {
    const productId = await registerProduct(context, {
      name: "米粉パン",
      priceJpy: 240,
      allergens: [],
    });
    expect(fake.rawProduct(productId)?.allergens).toEqual([]);
  });

  it("不正な入力は保存する前に落とす", async () => {
    await expect(registerProduct(context, { ...croissant, priceJpy: 0 })).rejects.toThrow(
      /1 円以上/,
    );
    await expect(registerProduct(context, { ...croissant, name: " " })).rejects.toThrow(/空/);
    expect(fake.rawProduct("product-1")).toBeNull();
  });

  it("登録ではイベントを出さない (契約にあるのは販売停止だけ)", async () => {
    await registerProduct(context, croissant);
    expect(fake.publishedEvents()).toEqual([]);
  });
});

describe("changePrice", () => {
  it("上書きではなく履歴に追記する", async () => {
    const productId = await registerProduct(context, croissant);

    clock = new Date("2026-10-01T00:00:00.000Z");
    await changePrice(context, { productId, priceJpy: 300 });

    expect(fake.priceHistory(productId)).toEqual([
      { priceJpy: 280, effectiveFrom: new Date("2026-09-11T00:00:00.000Z") },
      { priceJpy: 300, effectiveFrom: new Date("2026-10-01T00:00:00.000Z") },
    ]);
  });

  it("改定後は現在価格が新しい方になる", async () => {
    const productId = await registerProduct(context, croissant);
    clock = new Date("2026-10-01T00:00:00.000Z");
    await changePrice(context, { productId, priceJpy: 300 });

    expect((await getProduct(context, productId))?.priceJpy).toBe(300);
  });

  it("存在しない商品は改定できない", async () => {
    await expect(changePrice(context, { productId: "unknown", priceJpy: 300 })).rejects.toThrow(
      ProductNotFoundError,
    );
  });

  it("販売停止した商品の定価は動かさない", async () => {
    const productId = await registerProduct(context, croissant);
    await delistProduct(context, { productId, reason: "discontinued" });

    await expect(changePrice(context, { productId, priceJpy: 300 })).rejects.toThrow(
      ProductNotSellableError,
    );
    expect(fake.priceHistory(productId)).toHaveLength(1);
  });

  it("同じ値の再改定では履歴を増やさない (再送・二度押しで履歴が汚れないため)", async () => {
    const productId = await registerProduct(context, croissant);

    clock = new Date("2026-10-01T00:00:00.000Z");
    await changePrice(context, { productId, priceJpy: 280 });

    expect(fake.priceHistory(productId)).toEqual([
      { priceJpy: 280, effectiveFrom: new Date("2026-09-11T00:00:00.000Z") },
    ]);
  });

  it("値を戻す改定は履歴に残る (280 -> 300 -> 280)", async () => {
    const productId = await registerProduct(context, croissant);
    clock = new Date("2026-10-01T00:00:00.000Z");
    await changePrice(context, { productId, priceJpy: 300 });
    clock = new Date("2026-11-01T00:00:00.000Z");
    await changePrice(context, { productId, priceJpy: 280 });

    expect(fake.priceHistory(productId).map((price) => price.priceJpy)).toEqual([280, 300, 280]);
  });

  it("価格改定ではイベントを出さない", async () => {
    const productId = await registerProduct(context, croissant);
    await changePrice(context, { productId, priceJpy: 300 });
    expect(fake.publishedEvents()).toEqual([]);
  });
});

describe("delistProduct", () => {
  it("商品を消さずに sellable = false にする", async () => {
    const productId = await registerProduct(context, croissant);
    await delistProduct(context, { productId, reason: "seasonal" });

    const stored = fake.rawProduct(productId);
    expect(stored).not.toBeNull();
    expect(stored?.sellable).toBe(false);
    expect(stored?.delistReason).toBe("seasonal");
    expect(stored?.delistedAt).toEqual(clock);
  });

  it("catalog.ProductDelisted を業務データの更新と同じトランザクションで積む", async () => {
    const productId = await registerProduct(context, croissant);
    await delistProduct(context, { productId, reason: "supply_shortage" });

    expect(fake.publishedEvents()).toEqual([
      {
        name: "catalog.ProductDelisted",
        payload: {
          productId,
          delistedAt: clock.toISOString(),
          reason: "supply_shortage",
        },
      },
    ]);
  });

  it("イベントに載せるのは事実だけ。名前も価格もアレルゲンも載せない", async () => {
    const productId = await registerProduct(context, croissant);
    await delistProduct(context, { productId, reason: "other" });

    const payload = fake.publishedEvents()[0]?.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["delistedAt", "productId", "reason"]);
  });

  it("存在しない商品は停止できず、イベントも出ない", async () => {
    await expect(delistProduct(context, { productId: "unknown", reason: "other" })).rejects.toThrow(
      ProductNotFoundError,
    );
    expect(fake.publishedEvents()).toEqual([]);
  });

  it("二重の停止は弾く。イベントが2回出ると購読側が二重に処理するため", async () => {
    const productId = await registerProduct(context, croissant);
    await delistProduct(context, { productId, reason: "discontinued" });

    await expect(delistProduct(context, { productId, reason: "discontinued" })).rejects.toThrow(
      ProductNotSellableError,
    );
    expect(fake.publishedEvents()).toHaveLength(1);
  });

  it("停止が失敗したらイベントも巻き戻る (片方だけ残らない)", async () => {
    const productId = await registerProduct(context, croissant);
    await delistProduct(context, { productId, reason: "discontinued" });
    const eventsAfterFirst = fake.publishedEvents().length;

    await expect(delistProduct(context, { productId, reason: "other" })).rejects.toThrow();

    expect(fake.publishedEvents()).toHaveLength(eventsAfterFirst);
    expect(fake.rawProduct(productId)?.delistReason).toBe("discontinued");
  });
});

describe("getProduct / listSellableProducts", () => {
  it("getProduct は販売停止した商品も返す (他モジュールが過去の参照を解決するため)", async () => {
    const productId = await registerProduct(context, croissant);
    await delistProduct(context, { productId, reason: "seasonal" });

    const view = await getProduct(context, productId);
    expect(view).not.toBeNull();
    expect(view?.sellable).toBe(false);
    // 停止しても最後の定価は引ける。過去の売上の照合に要る。
    expect(view?.priceJpy).toBe(280);
  });

  it("存在しない商品は null", async () => {
    expect(await getProduct(context, "unknown")).toBeNull();
  });

  it("listSellableProducts は販売停止した商品を含まない", async () => {
    const keep = await registerProduct(context, croissant);
    const drop = await registerProduct(context, { ...croissant, name: "季節のパン" });
    await delistProduct(context, { productId: drop, reason: "seasonal" });

    const listed = await listSellableProducts(context);
    expect(listed.map((product) => product.productId)).toEqual([keep]);
  });
});
