/**
 * セクションの枠。
 *
 * 読み込み中・失敗・空を同じ形で出す。API は 5 つのコンテキストに分かれていて
 * どれか 1 つが落ちることがあるので、失敗はセクションの中に閉じ込める。
 */
import type { ReactNode } from "react";
import type { AsyncState } from "../use-async.ts";

type SectionProps = {
  readonly title: string;
  readonly note?: string;
  readonly source: string;
  readonly children: ReactNode;
};

export function Section({ title, note, source, children }: SectionProps) {
  return (
    <section className="section">
      <header className="section-header">
        <h2>{title}</h2>
        {/* どのコンテキストの数字なのかを画面にも出す。 */}
        <span className="source" title="この数字の出どころ">
          {source}
        </span>
      </header>
      {note !== undefined && <p className="note">{note}</p>}
      {children}
    </section>
  );
}

type AsyncBodyProps<T> = {
  readonly state: AsyncState<T>;
  readonly empty?: string;
  readonly isEmpty?: (value: T) => boolean;
  readonly children: (value: T) => ReactNode;
};

export function AsyncBody<T>({ state, empty, isEmpty, children }: AsyncBodyProps<T>) {
  if (state.error !== null && state.value === null) {
    return (
      <p className="status error">
        <strong>取得できませんでした</strong>
        <span>{state.error.message}</span>
      </p>
    );
  }
  if (state.value === null) {
    return <p className="status">読み込み中…</p>;
  }
  if (isEmpty?.(state.value) === true) {
    return <p className="status">{empty ?? "まだデータがありません"}</p>;
  }
  return (
    <>
      {/* 再取得に失敗しても、前回の値は消さずに注意書きだけ出す。 */}
      {state.error !== null && <p className="status error">更新に失敗: {state.error.message}</p>}
      {children(state.value)}
    </>
  );
}
