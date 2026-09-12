import { describe, expect, it } from "vitest";
import { handleApi } from "../server/api";

describe("Worker API", () => {
  it("reports health", async () => {
    const response = await handleApi(new Request("https://example.com/api/health"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, site: "__SITE_ID__" });
  });

  it("returns a structured 404", async () => {
    const response = await handleApi(new Request("https://example.com/api/missing"));
    expect(response.status).toBe(404);
  });
});
