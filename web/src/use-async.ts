/**
 * 非同期の取得を「読み込み中 / 取得済み / 失敗」の 3 状態で持つ。
 *
 * 画面はコンテキストをまたぐので、**1 つの API が落ちても他が見えること**を優先する。
 * セクションごとに独立した状態を持たせ、失敗はそのセクションの中に閉じ込める。
 *
 * 再取得のきっかけ (定期更新・手動更新) はこのフックの中に持たせてある。
 * 外から「更新用のカウンタ」を渡す作りにすると、そのカウンタは effect の本体では
 * 使われない余分な依存になり (Biome の useExhaustiveDependencies が指摘する)、
 * 「何が再取得のきっかけなのか」もフックの外に散らばるため。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type AsyncState<T> = {
  readonly loading: boolean;
  /** 再取得中も前回の値を持ち続ける。自動更新のたびに表が消えないようにするため。 */
  readonly value: T | null;
  readonly error: Error | null;
  /** 手動での再取得。 */
  readonly refresh: () => void;
};

export function useAsync<T>(
  /** 呼び出し側で useCallback により安定させること。これが変わると取り直す。 */
  load: (signal: AbortSignal) => Promise<T>,
  /** 定期更新の間隔 (ms)。イベント配信は結果整合なので、放っておいても追いつく。 */
  intervalMs: number,
): AsyncState<T> {
  const [state, setState] = useState<Omit<AsyncState<T>, "refresh">>({
    loading: true,
    value: null,
    error: null,
  });

  // 手動更新から今の取得処理を呼べるようにしておく。
  const runRef = useRef<() => void>(() => {});

  useEffect(() => {
    const controller = new AbortController();

    const run = (): void => {
      setState((previous) => ({ ...previous, loading: true }));
      load(controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setState({ loading: false, value, error: null });
        })
        .catch((error: unknown) => {
          // アンマウント時の abort は失敗ではない。
          if (controller.signal.aborted) return;
          setState((previous) => ({
            loading: false,
            value: previous.value,
            error: error instanceof Error ? error : new Error(String(error)),
          }));
        });
    };

    runRef.current = run;
    run();
    const timer = setInterval(run, intervalMs);

    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [load, intervalMs]);

  const refresh = useCallback(() => {
    runRef.current();
  }, []);

  return { ...state, refresh };
}
