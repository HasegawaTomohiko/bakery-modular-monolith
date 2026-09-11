/**
 * イベントの配信。
 *
 * モジュラーモノリスなので配信はプロセス内で完結する。ただし**購読側の DB 接続は
 * 購読側のロール**を使うため、ハンドラは相手のスキーマに触れない (境界の強制 2/3)。
 *
 * shared はモジュールを知らない。購読の登録はエントリポイント (worker) が行う。
 * 依存の向きが entrypoints → modules → shared の一方向になるようにするため。
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { MODULES, type ModuleName, type SchemaOwner } from "./config.ts";
import { type EventEnvelope, type EventName, publisherOf } from "./events.ts";
import { handleOnce } from "./inbox.ts";
import { fetchUnpublished, markPublished } from "./outbox.ts";
import type { Executor } from "./tables.ts";

/** モジュール名から、そのモジュール専用ロールの接続を引く。 */
export type DbResolver = (owner: SchemaOwner) => NodePgDatabase;

export type Subscription<N extends EventName = EventName> = {
  /** 購読するモジュール。処理はこのモジュールのロールとスキーマの中で完結する。 */
  readonly subscriber: SchemaOwner;
  /** 購読側モジュール内で一意な名前。inbox の冪等キーの一部になる。 */
  readonly handler: string;
  readonly eventName: N;
  readonly handle: (event: EventEnvelope<N>, tx: Executor) => Promise<void>;
};

/**
 * 型を保ったまま購読を1つ定義する。
 * 呼び出し側では `EventEnvelope<N>` として扱え、束ねるときだけ直和に均す。
 */
export function defineSubscription<N extends EventName>(
  subscription: Subscription<N>,
): Subscription {
  // 直和に均す。ルーティングは eventName で行うので、実行時に型がずれることはない。
  return subscription as unknown as Subscription;
}

export type EventBus = {
  /** イベント1件を全購読者へ配る。購読者ごとに冪等。 */
  dispatch(event: EventEnvelope): Promise<void>;
  subscriptionsFor(name: EventName): readonly Subscription[];
};

export function createEventBus(
  subscriptions: readonly Subscription[],
  resolveDb: DbResolver,
): EventBus {
  const seen = new Set<string>();
  for (const subscription of subscriptions) {
    // 自分が出したイベントを自分で購読しない。同一モジュール内なら直接呼べばよく、
    // outbox を経由すると理由もなく結果整合になるため。
    if (publisherOf(subscription.eventName) === subscription.subscriber) {
      throw new Error(
        `${subscription.subscriber} が自分の発行した ${subscription.eventName} を購読しています`,
      );
    }
    const key = `${subscription.subscriber}/${subscription.handler}`;
    if (seen.has(key)) {
      throw new Error(`購読ハンドラ名が重複しています: ${key}`);
    }
    seen.add(key);
  }

  const byEvent = new Map<EventName, Subscription[]>();
  for (const subscription of subscriptions) {
    const list = byEvent.get(subscription.eventName) ?? [];
    list.push(subscription);
    byEvent.set(subscription.eventName, list);
  }

  return {
    subscriptionsFor(name) {
      return byEvent.get(name) ?? [];
    },
    async dispatch(event) {
      for (const subscription of byEvent.get(event.name) ?? []) {
        await handleOnce(
          resolveDb(subscription.subscriber),
          subscription.subscriber,
          subscription.handler,
          event,
          (tx) => subscription.handle(event, tx),
        );
      }
    },
  };
}

export type RelayOptions = {
  readonly batchSize?: number;
  readonly modules?: readonly ModuleName[];
};

/**
 * 全モジュールの outbox を1周する。配信できた件数を返す。
 *
 * 取り出しから published 印までを発行側の1トランザクションに収める。
 * 途中で購読側が失敗したらロールバックし、印が付かないので次の周回で再送される。
 * 既に成功した購読者は inbox で二重処理を弾く。
 */
export async function relayOnce(
  bus: EventBus,
  resolveDb: DbResolver,
  options: RelayOptions = {},
): Promise<number> {
  const batchSize = options.batchSize ?? 50;
  const modules = options.modules ?? MODULES;
  let delivered = 0;

  for (const module of modules) {
    await resolveDb(module).transaction(async (tx) => {
      const events = await fetchUnpublished(tx, module, batchSize);
      for (const event of events) {
        await bus.dispatch(event);
        await markPublished(tx, module, event.id);
        delivered += 1;
      }
    });
  }

  return delivered;
}

export type RelayLoop = {
  stop(): Promise<void>;
};

/** worker 本体。停止要求が来るまで relayOnce を回し続ける。 */
export function startRelayLoop(params: {
  bus: EventBus;
  resolveDb: DbResolver;
  intervalMs: number;
  onError?: (error: unknown) => void;
  options?: RelayOptions;
}): RelayLoop {
  let stopped = false;
  let wake: (() => void) | undefined;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const running = (async () => {
    while (!stopped) {
      try {
        const delivered = await relayOnce(params.bus, params.resolveDb, params.options);
        // 溜まっているうちは間を空けずに次の周回へ。
        if (delivered > 0) continue;
      } catch (error) {
        // 落とさない。次の周回で再送される。
        params.onError?.(error);
      }
      if (stopped) break;
      await sleep(params.intervalMs);
    }
  })();

  return {
    async stop() {
      stopped = true;
      wake?.();
      await running;
    },
  };
}
