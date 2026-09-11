/**
 * 境界の強制 (3/3): 通信。
 *
 * 状態変化の通知は transactional outbox 経由のイベントのみ、という経路が
 * 実際に通ることを固定する。ここが壊れるとモジュール間の連携が全部止まる。
 *
 * 確認するのは4点:
 *   1. 発行側 outbox → worker → 購読側 inbox が通る
 *   2. 2周目で同じイベントを2回処理しない (at-least-once を inbox が吸収する)
 *   3. 購読側が失敗したら published 印が付かず、次の周回で再送される
 *   4. 発行元でないモジュールはイベントを発行できない
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { moduleDb } from "../../src/shared/db.ts";
import {
  createEventBus,
  defineSubscription,
  relayOnce,
  type Subscription,
} from "../../src/shared/event-bus.ts";
import type { EventPayload } from "../../src/shared/events.ts";
import { publishEvent } from "../../src/shared/outbox.ts";
import { truncateModule } from "../helpers/db.ts";

const delisted = (): EventPayload<"catalog.ProductDelisted"> => ({
  productId: "11111111-1111-4111-8111-111111111111",
  delistedAt: new Date().toISOString(),
  reason: "seasonal",
});

/** catalog が販売停止イベントを1件積む。業務データと同じトランザクションで書く体。 */
async function publishDelisted(): Promise<void> {
  await moduleDb("catalog").transaction(async (tx) => {
    await publishEvent(tx, "catalog", "catalog.ProductDelisted", delisted());
  });
}

async function countRows(module: "catalog" | "sales", table: string): Promise<number> {
  const result = await moduleDb(module).execute<{ count: string }>(
    sql`select count(*)::text as count from ${sql.identifier(module)}.${sql.identifier(table)}`,
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function unpublishedCount(): Promise<number> {
  const result = await moduleDb("catalog").execute<{ count: string }>(
    sql`select count(*)::text as count from catalog.outbox where published_at is null`,
  );
  return Number(result.rows[0]?.count ?? "0");
}

describe("outbox → worker → inbox", () => {
  beforeEach(async () => {
    await truncateModule("catalog");
    await truncateModule("sales");
  });

  it("発行側の outbox から購読側の inbox まで通る", async () => {
    const received: string[] = [];
    const bus = createEventBus(
      [
        defineSubscription({
          subscriber: "sales",
          handler: "test-delisted",
          eventName: "catalog.ProductDelisted",
          handle: async (event) => {
            received.push(event.payload.productId);
          },
        }),
      ],
      moduleDb,
    );

    await publishDelisted();
    expect(await unpublishedCount()).toBe(1);

    const delivered = await relayOnce(bus, moduleDb);

    expect(delivered).toBe(1);
    expect(received).toEqual([delisted().productId]);
    // 購読側の inbox に処理済みとして残る
    expect(await countRows("sales", "inbox")).toBe(1);
    // 発行側は配信済みになる
    expect(await unpublishedCount()).toBe(0);
  });

  it("同じイベントを2回処理しない", async () => {
    let calls = 0;
    const subscription: Subscription = defineSubscription({
      subscriber: "sales",
      handler: "test-delisted",
      eventName: "catalog.ProductDelisted",
      handle: async () => {
        calls += 1;
      },
    });

    await publishDelisted();
    await relayOnce(createEventBus([subscription], moduleDb), moduleDb);
    expect(calls).toBe(1);

    // 配信済みの印を消して、worker が同じ行をもう一度拾う状況を作る。
    // (worker が印を付ける前に落ちた場合に相当する)
    await moduleDb("catalog").execute(sql`update catalog.outbox set published_at = null`);

    await relayOnce(createEventBus([subscription], moduleDb), moduleDb);

    // 2周目は inbox が弾くのでハンドラは動かない
    expect(calls).toBe(1);
    expect(await countRows("sales", "inbox")).toBe(1);
    // それでも配信済みの印は付き直す
    expect(await unpublishedCount()).toBe(0);
  });

  it("購読側が失敗したら配信済みにせず、次の周回で再送する", async () => {
    let attempts = 0;
    const bus = createEventBus(
      [
        defineSubscription({
          subscriber: "sales",
          handler: "test-delisted",
          eventName: "catalog.ProductDelisted",
          handle: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("購読側の一時的な失敗");
          },
        }),
      ],
      moduleDb,
    );

    await publishDelisted();

    await expect(relayOnce(bus, moduleDb)).rejects.toThrow("購読側の一時的な失敗");
    // 失敗したので印は付かない = 次の周回で再送される
    expect(await unpublishedCount()).toBe(1);
    // inbox にも入らない (処理と記録は同じトランザクション)
    expect(await countRows("sales", "inbox")).toBe(0);

    const delivered = await relayOnce(bus, moduleDb);

    expect(delivered).toBe(1);
    expect(attempts).toBe(2);
    expect(await unpublishedCount()).toBe(0);
    expect(await countRows("sales", "inbox")).toBe(1);
  });

  it("発行元でないモジュールはイベントを発行できない", async () => {
    await expect(
      moduleDb("sales").transaction(async (tx) => {
        // sales は catalog のイベントを発行できない。
        await publishEvent(tx, "sales", "catalog.ProductDelisted", delisted());
      }),
    ).rejects.toThrow("sales は catalog.ProductDelisted を発行できません");
  });

  it("自分の発行したイベントを自分で購読することはできない", () => {
    expect(() =>
      createEventBus(
        [
          defineSubscription({
            subscriber: "catalog",
            handler: "self",
            eventName: "catalog.ProductDelisted",
            handle: async () => {},
          }),
        ],
        moduleDb,
      ),
    ).toThrow("catalog が自分の発行した catalog.ProductDelisted を購読しています");
  });
});
