import { expect, it } from "vitest";
import { APP_NAME } from "../../src/shared/placeholder.ts";

it("boots the toolchain", () => {
  expect(APP_NAME).toBe("bakery");
});
