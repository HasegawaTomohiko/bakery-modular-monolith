/**
 * catalog.ProductDelisted の購読。
 *
 * 商品の名前・価格・アレルゲンは catalog の持ち物なので持たない。sales が持つのは
 * 「この商品はもう売ってはいけない」という**参照コピー**だけ。イベントが運ぶのは
 * 「状態が変わった」という事実だけなので、それを自分の判断材料として写し取る。
 *
 * 書き込みは shared の inbox と同じトランザクションで行われる (冪等)。
 */
import type { EventPayload } from "../../../shared/events.ts";

export type ProductReferenceCopy = {
  markDelisted(productId: string, delistedAt: Date, reason: string): Promise<void>;
};

export async function handleProductDelisted(
  copy: ProductReferenceCopy,
  payload: EventPayload<"catalog.ProductDelisted">,
): Promise<void> {
  await copy.markDelisted(payload.productId, new Date(payload.delistedAt), payload.reason);
}
