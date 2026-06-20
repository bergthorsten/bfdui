import { describe, expect, test } from "vitest";
import { openExternalLinkInputSchema } from "@/ipc/shell/schemas";

describe("openExternalLinkInputSchema", () => {
  test("accepts only HTTPS external links", () => {
    expect(
      openExternalLinkInputSchema.safeParse({ url: "https://example.com/path" })
        .success
    ).toBe(true);

    for (const url of [
      "http://example.com",
      "file:///tmp/secrets.txt",
      "javascript:alert(1)",
      "not-a-url",
    ]) {
      expect(openExternalLinkInputSchema.safeParse({ url }).success).toBe(
        false
      );
    }
  });
});
