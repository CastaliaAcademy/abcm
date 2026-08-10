import { describe, expect, test } from "bun:test";

import { requireStaticBearerToken } from "../src/rest/static-bearer-auth.js";

describe("REST static bearer boundary", () => {
  const protectedHandler = requireStaticBearerToken(async () => Response.json({ ok: true }), "secret-token-1234");

  test("rejects weak configured tokens", () => {
    expect(() => requireStaticBearerToken(async () => Response.json({ ok: true }), "too-short")).toThrow(
      "at least 16 characters",
    );
  });

  test("keeps health public", async () => {
    expect((await protectedHandler(new Request("http://localhost/health"))).status).toBe(200);
  });

  test("rejects missing or invalid bearer tokens", async () => {
    const missing = await protectedHandler(new Request("http://localhost/v1/workspaces/test/files"));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    const invalid = await protectedHandler(
      new Request("http://localhost/v1/workspaces/test/files", { headers: { authorization: "Bearer wrong" } }),
    );
    expect(invalid.status).toBe(401);
  });

  test("allows the configured bearer token", async () => {
    const response = await protectedHandler(
      new Request("http://localhost/v1/workspaces/test/files", { headers: { authorization: "Bearer secret-token-1234" } }),
    );
    expect(response.status).toBe(200);
  });
});
