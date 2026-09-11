/**
 * purchasing の統合テスト。実際の PostgreSQL に対して走る。
 *
 * 単体テスト (src/modules/purchasing/**\/*.test.ts) が業務の筋を見るのに対して、
 * ここで見たいのは**経路と制約が本当に効いているか**の3点:
 *
 *   1. 検収したイベントが purchasing.outbox に載り、relay で購読側の inbox まで届く
 *   2. 入荷しただけではイベントが出ない (在庫になるのは検収後)
 *   3. 重複提案の防止が DB の部分ユニークインデックスで効いている
 *
 * 購読側の inventory は並行実装中なので、購読はこのファイル内のダミーで作る。
 * 確認したいのは経路であって inventory の入庫処理ではない。
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { purchasing, purchasingSubscriptions } from "../../src/modules/purchasing/index.ts";
import { moduleDb } from "../../src/shared/db.ts";
import { createEventBus, defineSubscription, relayOnce } from "../../src/shared/event-bus.ts";
import type { EventEnvelope, EventPayload, Quantity } from "../../src/shared/events.ts";
import { truncateModule } from "../helpers/db.ts";

const FLOUR = "aaaaaaaa-0000-4000-8000-000000000001";
const BUTTER = "aaaaaaaa-0000-4000-8000-000000000002";

const g = (amount: number): Quantity => ({ amount, unit: "g" });

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
  const result = await moduleDb("purchasing").execute<{ value: string }>(query);
  return Number(result.rows[0]?.value ?? "0");
}

/**
 * SQL が失敗したときの SQLSTATE と制約名を取り出す。
 *
 * drizzle は pg の DatabaseError を DrizzleQueryError で包むので、外側には
 * "Failed query: ..." しか無い。制約名は cause 側に入っているので辿る。
 * (tests/helpers/db.ts の describeError と同じ事情)
 */
async function pgFailureOf(
  run: () => Promise<unknown>,
): Promise<{ code: string | undefined; constraint: string | undefined; message: string }> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof Error)) {
      throw new Error(`Error ではない値が投げられました: ${String(error)}`);
    }
    const messages: string[] = [];
    let code: string | undefined;
    let constraint: string | undefined;
    let current: Error | undefined = error;
    while (current !== undefined) {
      messages.push(current.message);
      if (code === undefined && "code" in current && typeof current.code === "string") {
        code = current.code;
      }
      if (
        constraint === undefined &&
        "constraint" in current &&
        typeof current.constraint === "string"
      ) {
        constraint = current.constraint;
      }
      current = current.cause instanceof Error ? current.cause : undefined;
    }
    return { code, constraint, message: messages.join("\n") };
  }
  throw new Error("SQL が成功しました。制約が効いていません");
}

const countOutbox = (): Promise<number> =>
  scalar(sql`select count(*)::text as value from purchasing.outbox`);

const countUnpublished = (): Promise<number> =>
  scalar(sql`select count(*)::text as value from purchasing.outbox where published_at is null`);

const countSuggestions = (status: string): Promise<number> =>
  scalar(
    sql`select count(*)::text as value from purchasing.purchase_suggestions where status = ${status}`,
  );

/** 仕入先を作って発注し、9.8kg だけ入荷する (発注は 10kg + バター 2kg)。 */
async function orderAndReceive(): Promise<{ purchaseOrderId: string; goodsReceiptId: string }> {
  const supplierId = await purchasing.registerSupplier({ name: "山田製粉", leadTimeDays: 2 });
  const purchaseOrderId = await purchasing.placePurchaseOrder({
    supplierId,
    lines: [
      { ingredientId: FLOUR, quantity: g(10_000) },
      { ingredientId: BUTTER, quantity: g(2_000) },
    ],
  });
  const goodsReceiptId = await purchasing.receiveGoods({
    purchaseOrderId,
    receivedAt: new Date().toISOString(),
    lines: [
      { ingredientId: FLOUR, quantity: g(9_800), lotCode: "LOT-A", bestBefore: "2026-12-31" },
    ],
  });
  return { purchaseOrderId, goodsReceiptId };
}

describe("purchasing: 発注から検収まで", () => {
  beforeEach(async () => {
    await truncateModule("purchasing");
  });

  it("発注を保存して読み戻せる", async () => {
    const { purchaseOrderId } = await orderAndReceive();
    const order = await purchasing.getPurchaseOrder(purchaseOrderId);

    expect(order).not.toBeNull();
    expect(order?.status).toBe("received");
    // 明細の並びは入力順のまま (line_no で保つ)
    expect(order?.lines.map((line) => line.ingredientId)).toEqual([FLOUR, BUTTER]);
    // numeric 列を経由しても数量が壊れない
    expect(order?.lines[0]?.quantity).toEqual(g(10_000));
  });

  it("存在しない発注は null", async () => {
    await expect(
      purchasing.getPurchaseOrder("99999999-9999-4999-8999-999999999999"),
    ).resolves.toBeNull();
  });

  it("入荷しただけではイベントが出ない", async () => {
    // モノが届いただけ。数量も品質もまだ確認していないので在庫にはならない。
    await orderAndReceive();
    expect(await countOutbox()).toBe(0);
  });

  it("検収して初めて outbox にイベントが載る", async () => {
    const { goodsReceiptId } = await orderAndReceive();

    await purchasing.acceptGoodsReceipt({
      goodsReceiptId,
      acceptedAt: new Date().toISOString(),
    });

    expect(await countOutbox()).toBe(1);
    expect(await countUnpublished()).toBe(1);
  });

  it("二重検収は落ち、イベントも増えない", async () => {
    const { goodsReceiptId } = await orderAndReceive();
    const acceptedAt = new Date().toISOString();
    await purchasing.acceptGoodsReceipt({ goodsReceiptId, acceptedAt });

    await expect(purchasing.acceptGoodsReceipt({ goodsReceiptId, acceptedAt })).rejects.toThrow(
      "既に",
    );

    // 失敗したトランザクションは outbox にも何も残さない
    expect(await countOutbox()).toBe(1);
  });
});

describe("purchasing: 検収イベントが購読側に届く", () => {
  beforeEach(async () => {
    await truncateModule("purchasing");
  });

  it("outbox → relay → 購読側まで通り、検収した実数が載っている", async () => {
    const { purchaseOrderId, goodsReceiptId } = await orderAndReceive();
    const acceptedAt = new Date().toISOString();

    // 本来の購読側は inventory。並行実装中なのでダミーで経路だけ確認する。
    // inventory の業務テーブルには触れない (触れる権限も無い)。
    const received: EventPayload<"purchasing.GoodsReceiptAccepted">[] = [];
    const bus = createEventBus(
      [
        defineSubscription({
          subscriber: "inventory",
          handler: "test-goods-receipt-accepted",
          eventName: "purchasing.GoodsReceiptAccepted",
          handle: async (event) => {
            received.push(event.payload);
          },
        }),
      ],
      moduleDb,
    );

    await purchasing.acceptGoodsReceipt({ goodsReceiptId, acceptedAt });
    expect(await countUnpublished()).toBe(1);

    // 自分の outbox だけを回す。他モジュールの outbox は並行実装中なので触らない。
    const delivered = await relayOnce(bus, moduleDb, { modules: ["purchasing"] });

    expect(delivered).toBe(1);
    expect(received).toHaveLength(1);

    const payload = received[0];
    expect(payload?.goodsReceiptId).toBe(goodsReceiptId);
    expect(payload?.purchaseOrderId).toBe(purchaseOrderId);
    expect(payload?.acceptedAt).toBe(acceptedAt);
    // 発注は 10kg だが、載るのは検収した実数の 9.8kg
    expect(payload?.lines).toEqual([
      { ingredientId: FLOUR, quantity: g(9_800), lotCode: "LOT-A", bestBefore: "2026-12-31" },
    ]);

    // 配信済みの印が付く
    expect(await countUnpublished()).toBe(0);
  });

  it("契約に合わないイベントは outbox に入る前に落ちる", async () => {
    // publishEvent が zod で検証する。壊れた payload を入れると配信時まで
    // 気づけず、購読側から見て原因の分からない失敗になるため。
    const { goodsReceiptId } = await orderAndReceive();

    await expect(
      purchasing.acceptGoodsReceipt({ goodsReceiptId, acceptedAt: "きのう" }),
    ).rejects.toThrow("acceptedAt");

    expect(await countOutbox()).toBe(0);
  });
});

describe("purchasing: 発注点割れから発注提案を作る", () => {
  beforeEach(async () => {
    await truncateModule("purchasing");
  });

  /** inventory が発注点割れを出した体で、購読ハンドラに直接配る。 */
  function breachEnvelope(
    eventId: string,
    ingredientId: string,
  ): EventEnvelope<"inventory.ReorderPointBreached"> {
    return {
      id: eventId,
      name: "inventory.ReorderPointBreached",
      payload: {
        ingredientId,
        onHand: g(1_200),
        reorderPoint: g(2_000),
        suggestedOrderQuantity: g(25_000),
        detectedAt: new Date().toISOString(),
      },
      occurredAt: new Date(),
    };
  }

  // 本物の購読定義を使う。inventory の outbox は並行実装中なので経由しない。
  const bus = createEventBus([...purchasingSubscriptions], moduleDb);

  it("発注点割れを受けて提案を作る", async () => {
    await bus.dispatch(breachEnvelope("11111111-0000-4000-8000-000000000001", FLOUR));

    const suggestions = await purchasing.listPurchaseSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      ingredientId: FLOUR,
      suggestedQuantity: g(25_000),
      onHandAtDetection: g(1_200),
    });
  });

  it("自動発注はしない (提案が増えるだけ)", async () => {
    await bus.dispatch(breachEnvelope("11111111-0000-4000-8000-000000000002", FLOUR));

    const orders = await scalar(
      sql`select count(*)::text as value from purchasing.purchase_orders`,
    );
    expect(orders).toBe(0);
    expect(await countOutbox()).toBe(0);
  });

  it("同じイベントが2回届いても1回しか処理しない (inbox による冪等)", async () => {
    const envelope = breachEnvelope("11111111-0000-4000-8000-000000000003", FLOUR);

    await bus.dispatch(envelope);
    await bus.dispatch(envelope);

    expect(await countSuggestions("open")).toBe(1);
  });

  it("別のイベントでも未対応の提案が既にあれば重複して作らない", async () => {
    // inbox は event_id で弾くので、ここを守っているのは
    // purchase_suggestions_open_ingredient_idx (部分ユニークインデックス)。
    // 在庫が発注点付近を行き来すれば業務的に何度でも飛んでくる。
    await bus.dispatch(breachEnvelope("11111111-0000-4000-8000-000000000004", FLOUR));
    await bus.dispatch(breachEnvelope("11111111-0000-4000-8000-000000000005", FLOUR));

    expect(await countSuggestions("open")).toBe(1);
  });

  it("別の原材料の提案は独立して作られる", async () => {
    await bus.dispatch(breachEnvelope("11111111-0000-4000-8000-000000000006", FLOUR));
    await bus.dispatch(breachEnvelope("11111111-0000-4000-8000-000000000007", BUTTER));

    expect(await countSuggestions("open")).toBe(2);
  });

  it("発注すると提案は一覧から消え、同じ原材料で再び提案できる", async () => {
    await bus.dispatch(breachEnvelope("11111111-0000-4000-8000-000000000008", FLOUR));

    const supplierId = await purchasing.registerSupplier({ name: "山田製粉", leadTimeDays: 2 });
    await purchasing.placePurchaseOrder({
      supplierId,
      lines: [{ ingredientId: FLOUR, quantity: g(25_000) }],
    });

    await expect(purchasing.listPurchaseSuggestions()).resolves.toHaveLength(0);
    expect(await countSuggestions("ordered")).toBe(1);

    // 発注済みになったので、また割れれば提案してよい
    await bus.dispatch(breachEnvelope("11111111-0000-4000-8000-000000000009", FLOUR));
    expect(await countSuggestions("open")).toBe(1);
  });

  it("未対応の提案が2件入らないことを DB の制約が保証している", async () => {
    // アプリ側の判定をすり抜けても DB が拒否することを直接確かめる。
    await bus.dispatch(breachEnvelope("11111111-0000-4000-8000-00000000000a", FLOUR));

    const failure = await pgFailureOf(() =>
      moduleDb("purchasing").execute(sql`
        insert into purchasing.purchase_suggestions
          (ingredient_id, suggested_amount, suggested_unit, on_hand_amount, on_hand_unit, status, created_at)
        values (${FLOUR}, 25000, 'g', 1200, 'g', 'open', now())
      `),
    );

    // 23505 = unique_violation。部分ユニークインデックスが拒否している。
    expect(failure.code).toBe("23505");
    expect(failure.constraint).toBe("purchase_suggestions_open_ingredient_idx");
  });
});
