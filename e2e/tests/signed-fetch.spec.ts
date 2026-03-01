/// <reference path="./global.d.ts" />

import { test, expect } from "@playwright/test";

test.describe("signedFetch e2e", () => {
  test.beforeEach(async ({ page }) => {
    const baseURL = process.env.E2E_URL;
    if (!baseURL) throw new Error("E2E_URL env var not set");
    await page.goto(`${baseURL}/test`);
    // Wait for signedFetch to be available on window
    await page.waitForFunction(() => typeof window.signedFetch === "function");
  });

  test("POST with string body — hash matches", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const res = await window.signedFetch(location.origin + "/api", {
        method: "POST",
        body: JSON.stringify({ hello: "world" }),
        headers: { "Content-Type": "application/json" },
      });
      return res.json();
    });

    expect(result.method).toBe("POST");
    expect(result.hashMatch).toBe(true);
    expect(result.receivedHash).toBe(result.computedHash);
  });

  test("PUT with string body — hash matches", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const res = await window.signedFetch(location.origin + "/api", {
        method: "PUT",
        body: "some payload",
      });
      return res.json();
    });

    expect(result.method).toBe("PUT");
    expect(result.hashMatch).toBe(true);
  });

  test("POST with Blob body — hash matches", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const blob = new Blob(["blob content"], { type: "text/plain" });
      const res = await window.signedFetch(location.origin + "/api", {
        method: "POST",
        body: blob,
      });
      return res.json();
    });

    expect(result.hashMatch).toBe(true);
    expect(result.bodyLength).toBeGreaterThan(0);
  });

  test("POST with ArrayBuffer body — hash matches", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const buf = new TextEncoder().encode("arraybuffer content").buffer;
      const res = await window.signedFetch(location.origin + "/api", {
        method: "POST",
        body: buf,
      });
      return res.json();
    });

    expect(result.hashMatch).toBe(true);
  });

  test("POST with URLSearchParams body — hash matches", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const params = new URLSearchParams({ key: "value", foo: "bar" });
      const res = await window.signedFetch(location.origin + "/api", {
        method: "POST",
        body: params,
      });
      return res.json();
    });

    expect(result.hashMatch).toBe(true);
    expect(result.bodyLength).toBeGreaterThan(0);
  });

  test("GET without body — succeeds without hash header", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const res = await window.signedFetch(location.origin + "/api");
      return res.json();
    });

    expect(result.method).toBe("GET");
    expect(result.bodyLength).toBe(0);
  });

  test("POST without body — succeeds", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const res = await window.signedFetch(location.origin + "/api", {
        method: "POST",
      });
      return res.json();
    });

    expect(result.method).toBe("POST");
    expect(result.bodyLength).toBe(0);
  });

  test("POST with wrong hash — Lambda rejects (native fetch, no signedFetch)", async ({
    page,
  }) => {
    const status = await page.evaluate(async () => {
      const res = await fetch(location.origin + "/api", {
        method: "POST",
        body: "test",
        headers: {
          "x-amz-content-sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        },
      });
      return res.status;
    });

    // Lambda should reject with a non-200 status due to hash mismatch in SigV4
    expect(status).not.toBe(200);
  });
});
