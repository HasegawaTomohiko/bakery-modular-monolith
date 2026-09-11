/**
 * 発注提案。
 *
 * inventory が発注点割れを検知してイベントを出し、purchasing が**提案**を作る。
 * 自動発注はしない (リードタイムと最小ロットが絡むので確定は人の判断)。
 *
 * 提案が持つのは `ingredientId` だけ。原材料の名前は inventory の持ち物なので、
 * 画面側で在庫一覧と突き合わせて表示する (DB の JOIN ではなく、公開 API の合成)。
 */
import { formatDateTime, formatQuantity } from "../format.ts";
import type { IngredientStock, PurchaseSuggestion } from "../queries.ts";
import type { AsyncState } from "../use-async.ts";
import { AsyncBody, Section } from "./Section.tsx";

export function PurchaseSuggestions({
  state,
  ingredients,
}: {
  readonly state: AsyncState<PurchaseSuggestion[]>;
  readonly ingredients: IngredientStock[] | null;
}) {
  const nameOf = (ingredientId: string): string =>
    ingredients?.find((row) => row.ingredientId === ingredientId)?.name ??
    `${ingredientId.slice(0, 8)}…`;

  return (
    <Section
      title="発注提案"
      source="purchasing"
      note="発注点割れイベントから作られた提案。発注するかどうかは人が決める。"
    >
      <AsyncBody state={state} isEmpty={(rows) => rows.length === 0} empty="発注提案はありません">
        {(rows) => (
          <table>
            <thead>
              <tr>
                <th scope="col">原材料</th>
                <th scope="col" className="num">
                  提案数量
                </th>
                <th scope="col" className="num">
                  検知時の在庫
                </th>
                <th scope="col">作成</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.ingredientId}-${row.createdAt}`}>
                  <th scope="row">{nameOf(row.ingredientId)}</th>
                  <td className="num">{formatQuantity(row.suggestedQuantity)}</td>
                  <td className="num dim">{formatQuantity(row.onHandAtDetection)}</td>
                  <td className="dim">{formatDateTime(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AsyncBody>
    </Section>
  );
}
