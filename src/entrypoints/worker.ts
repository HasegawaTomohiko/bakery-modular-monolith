/**
 * worker エントリポイント。
 *
 * api と同じコードベースで、エントリポイントだけが違う。HTTP は持たない。
 * 役割は transactional outbox のリレー: 各モジュールが自スキーマの outbox に
 * 書いたイベントを取り出し、購読側モジュールに渡す。
 *
 * 購読の登録をここで行うのは、shared がモジュールを知らないようにするため。
 * 依存の向きは entrypoints → modules → shared の一方向。
 */
import { catalogSubscriptions } from "../modules/catalog/index.ts";
import { inventorySubscriptions } from "../modules/inventory/index.ts";
import { productionSubscriptions } from "../modules/production/index.ts";
import { purchasingSubscriptions } from "../modules/purchasing/index.ts";
import { salesSubscriptions } from "../modules/sales/index.ts";
import { readmodelSubscriptions } from "../readmodel/index.ts";
import { closeDbPools, moduleDb } from "../shared/db.ts";
import { createEventBus, startRelayLoop } from "../shared/event-bus.ts";

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000);

/**
 * コンテキスト間の購読表。docs/conventions/module-boundaries.md の表と一致させること。
 * 購読側は必ず自分のロールの接続で動くので、相手のスキーマには触れない。
 */
const subscriptions = [
  ...catalogSubscriptions,
  ...purchasingSubscriptions,
  ...inventorySubscriptions,
  ...productionSubscriptions,
  ...salesSubscriptions,
  // 参照モデル。モジュールではないが、購読側としては同じ扱い
  // (自分のロールの接続で、自分のスキーマの中だけを更新する)。
  ...readmodelSubscriptions,
];

const bus = createEventBus(subscriptions, moduleDb);

const loop = startRelayLoop({
  bus,
  resolveDb: moduleDb,
  intervalMs: POLL_INTERVAL_MS,
  // 1回の失敗でプロセスを落とさない。印が付かないので次の周回で再送される。
  onError: (error) => console.error("worker relay failed", error),
});

console.log(
  `worker started, polling every ${POLL_INTERVAL_MS}ms, ${subscriptions.length} subscriptions`,
);

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`worker received ${signal}, shutting down`);
  void loop
    .stop()
    .then(() => closeDbPools())
    .then(() => {
      console.log("worker stopped");
      process.exit(0);
    });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
