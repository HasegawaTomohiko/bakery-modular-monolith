/**
 * 特定原材料 (アレルゲン)。
 *
 * 表示義務があるので商品定義の必須項目として扱う。「未入力」と「アレルゲンなし」を
 * 区別できてしまうと表示漏れの原因になるため、値は常に配列で存在させ、
 * 「該当なし」は空配列で表す (null や undefined を許さない)。
 *
 * 品目の一覧は法令で決まるもので、catalog の都合で増減させない。
 * 契約 (index.ts の Allergen) と同じ集合であることは型テストで固定している。
 */

/**
 * 表示順もここで決める。ラベルに出す順番が登録順で変わると、
 * 同じ商品なのに表示が揺れて確認しづらくなるため。
 */
export const ALLERGENS = [
  "wheat",
  "egg",
  "milk",
  "soba",
  "peanut",
  "shrimp",
  "crab",
  "walnut",
] as const;

export type Allergen = (typeof ALLERGENS)[number];

const ORDER = new Map<Allergen, number>(ALLERGENS.map((allergen, index) => [allergen, index]));

export function isAllergen(value: string): value is Allergen {
  return ORDER.has(value as Allergen);
}

/**
 * 保存前に正規化する。重複を除き、ALLERGENS の順に並べ替える。
 *
 * 呼び出し側 (HTTP / 他モジュール) が同じ意味の値を別の並びで渡してくるため、
 * 保存の時点で1つの形に寄せる。こうしないと「小麦,卵」と「卵,小麦」が
 * 別物として保存され、表示と比較の両方で揺れる。
 */
export function normalizeAllergens(input: readonly Allergen[]): readonly Allergen[] {
  return [...new Set(input)].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));
}

/** DB から読んだ text[] を契約の型に戻す。未知の値は表示事故になるので落とす。 */
export function parseAllergens(stored: readonly string[]): readonly Allergen[] {
  const unknown = stored.filter((value) => !isAllergen(value));
  if (unknown.length > 0) {
    throw new Error(`catalog に未知のアレルゲンが保存されています: ${unknown.join(", ")}`);
  }
  return normalizeAllergens(stored.filter(isAllergen));
}
