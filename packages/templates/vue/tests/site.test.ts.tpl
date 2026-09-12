import { describe, expect, it } from "vitest";

describe("site configuration", () => {
  it("keeps the generated site identity", () => {
    expect("__SITE_ID__").toMatch(/^[a-z][a-z0-9-]{0,62}$/);
  });
});
