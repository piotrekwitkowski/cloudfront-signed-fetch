/// <reference path="./global.d.ts" />

/**
 * OAC Authorization-overwrite e2e tests
 *
 * ## What these tests prove
 *
 * ### 1. CloudFront Function (viewer-request) sees the client's original Authorization
 * The CF Function at /api/auth-required enforces Authorization: Bearer 1234 for write
 * methods. It runs BEFORE OAC signing — so it inspects the client's actual token.
 *
 * ### 2. Lambda Function URL strips the Authorization header from event.headers
 * Lambda Function URLs with AWS_IAM auth type consume and validate the Authorization
 * header (the OAC SigV4 signature) internally for authentication, then strip it from
 * the event.headers passed to the handler. This means:
 *   - The handler NEVER sees the client's original Authorization value
 *   - The handler NEVER sees the OAC SigV4 Authorization value either
 *   - The OAC signing DID happen — proven by x-amz-date, x-amz-security-token,
 *     x-amz-source-account, and x-amz-source-arn being present in event.headers
 *
 * ### 3. OAC SigV4 signing is proven via the x-amz-* headers Lambda receives
 * These headers are injected by OAC as part of the SigV4 signing process:
 *   - x-amz-date: timestamp of the signed request
 *   - x-amz-security-token: temporary credentials from the OAC assumed role
 *   - x-amz-source-account: the AWS account ID owning the distribution
 *   - x-amz-source-arn: the CloudFront distribution ARN
 *
 * ### 4. ALL_VIEWER origin request policy is incompatible with OAC + Lambda Function URL
 * Forwarding the Host header (the viewer's CloudFront hostname) to the Lambda Function
 * URL origin breaks OAC SigV4 signing: the Host in the signed request doesn't match
 * the actual Lambda URL host, causing a 403 AccessDeniedException.
 *
 * ### 5. x-amz-content-sha256 passes through unchanged in all working cases
 *
 * ## Test matrix
 *   /api/no-auth               Managed ALL_VIEWER_EXCEPT_HOST_HEADER, no auth gate
 *   /api/auth-required         Managed ALL_VIEWER_EXCEPT_HOST_HEADER + CF auth gate (Bearer 1234)
 *   /api/all-viewer            Managed ALL_VIEWER (includes Host) → 403 (incompatible with OAC)
 *   /api/custom-explicit-auth  Custom policy: all except Host (Authorization included via denyList)
 *   /api/custom-no-auth        Custom policy: all except Host and Authorization
 */

import { test, expect } from "@playwright/test";

const BEARER_TOKEN = "Bearer 1234";
const TEST_BODY = JSON.stringify({ test: "oac-auth-overwrite" });

// Helper: navigate to the test-harness page and wait for signedFetch
async function loadHarness(page: import("@playwright/test").Page) {
  const baseURL = process.env.E2E_URL;
  if (!baseURL) throw new Error("E2E_URL env var not set");
  await page.goto(`${baseURL}/`);
  await page.waitForFunction(() => typeof window.signedFetch === "function");
}

// Helper: assert OAC signing headers are present in Lambda's receivedHeaders.
// These prove that OAC performed SigV4 signing on the origin request, even though
// the Authorization header itself is stripped by the Lambda Function URL runtime.
function assertOacSigned(receivedHeaders: Record<string, string>) {
  // OAC injects these headers as part of SigV4 signing
  expect(receivedHeaders["x-amz-date"]).toBeTruthy();
  expect(receivedHeaders["x-amz-security-token"]).toBeTruthy();
  expect(receivedHeaders["x-amz-source-account"]).toBeTruthy();
  expect(receivedHeaders["x-amz-source-arn"]).toMatch(/cloudfront/);

  // The authorization header is ABSENT: Lambda Function URL consumes and strips it
  // during IAM authentication before passing event.headers to the handler.
  // This means neither the client's token nor the OAC SigV4 value is visible here.
  expect(receivedHeaders["authorization"]).toBeUndefined();
}

// ─── /api/auth-required ─────────────────────────────────────────────────────
// CloudFront Function checks Authorization: Bearer 1234 for write methods.
// If auth passes → OAC signs origin request → Lambda strips the Authorization header.

test.describe("/api/auth-required — CF Function auth gate + OAC signing proof", () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test("POST without Authorization → 401 from CloudFront Function (edge rejection)", async ({
    page,
  }) => {
    // The CF Function at viewer-request stage sees the missing Authorization and
    // returns 401 immediately — the request never reaches Lambda or OAC signing.
    const status = await page.evaluate(async (body) => {
      const res = await fetch(location.origin + "/api/auth-required", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
      });
      return res.status;
    }, TEST_BODY);

    expect(status).toBe(401);
  });

  test("GET without Authorization → 200 (GET is not gated by CF Function)", async ({ page }) => {
    // The CF auth gate only applies to POST/PUT/PATCH — GET passes through freely.
    const result = await page.evaluate(async () => {
      const res = await fetch(location.origin + "/api/auth-required");
      return { status: res.status, body: await res.json() };
    });

    expect(result.status).toBe(200);
    expect(result.body.method).toBe("GET");
    // OAC signed the GET request too
    assertOacSigned(result.body.receivedHeaders);
  });

  test(
    "POST with Authorization: Bearer 1234 → 200, OAC signing proven via x-amz-* headers",
    async ({ page }) => {
      // Flow:
      // 1. CF Function sees Authorization: Bearer 1234 → allows through
      // 2. OAC signs the origin request with SigV4 (overwrites Authorization)
      // 3. Lambda Function URL validates SigV4, then strips Authorization from event.headers
      // 4. Handler sees x-amz-date, x-amz-security-token etc. — proof of OAC signing
      const result = await page.evaluate(
        async ({ token, body }) => {
          const res = await window.signedFetch(location.origin + "/api/auth-required", {
            method: "POST",
            body,
            headers: {
              "Content-Type": "application/json",
              Authorization: token,
            },
          });
          return { status: res.status, body: await res.json() };
        },
        { token: BEARER_TOKEN, body: TEST_BODY },
      );

      // CF Function allowed the request through (correct bearer token)
      expect(result.status).toBe(200);

      // x-amz-content-sha256 passes through unchanged (core library behavior)
      expect(result.body.hashMatch).toBe(true);

      // OAC signing is proven by the presence of these headers
      assertOacSigned(result.body.receivedHeaders);
    },
  );

  test("PUT with Authorization: Bearer 1234 → 200, OAC signing proven", async ({ page }) => {
    const result = await page.evaluate(
      async ({ token, body }) => {
        const res = await window.signedFetch(location.origin + "/api/auth-required", {
          method: "PUT",
          body,
          headers: { Authorization: token },
        });
        return { status: res.status, body: await res.json() };
      },
      { token: BEARER_TOKEN, body: TEST_BODY },
    );

    expect(result.status).toBe(200);
    assertOacSigned(result.body.receivedHeaders);
  });

  test("PUT without Authorization → 401 from CloudFront Function", async ({ page }) => {
    const status = await page.evaluate(async (body) => {
      const res = await fetch(location.origin + "/api/auth-required", {
        method: "PUT",
        body,
      });
      return res.status;
    }, TEST_BODY);

    expect(status).toBe(401);
  });

  test("PATCH without Authorization → 401 from CloudFront Function", async ({ page }) => {
    const status = await page.evaluate(async (body) => {
      const res = await fetch(location.origin + "/api/auth-required", {
        method: "PATCH",
        body,
      });
      return res.status;
    }, TEST_BODY);

    expect(status).toBe(401);
  });
});

// ─── /api/all-viewer ─────────────────────────────────────────────────────────
// Managed ALL_VIEWER policy forwards ALL viewer headers including Host.
// FINDING: This is INCOMPATIBLE with OAC + Lambda Function URL.
// When the viewer's Host header (the CloudFront domain) is forwarded to the Lambda
// Function URL origin, OAC's SigV4 signature is computed using the wrong Host value.
// Lambda rejects the request with 403 AccessDeniedException.

test.describe("/api/all-viewer — Managed ALL_VIEWER policy (incompatible with OAC)", () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test(
    "POST → 403 (ALL_VIEWER forwards Host header, breaking OAC SigV4 signature)",
    async ({ page }) => {
      // When the origin request policy forwards the viewer's Host header, OAC
      // signs the request with that Host value. But the actual Lambda Function URL
      // has a different hostname — causing a signature mismatch and AccessDeniedException.
      // Use ALL_VIEWER_EXCEPT_HOST_HEADER instead for Lambda Function URL origins with OAC.
      const result = await page.evaluate(
        async ({ token, body }) => {
          const res = await window.signedFetch(location.origin + "/api/all-viewer", {
            method: "POST",
            body,
            headers: {
              "Content-Type": "application/json",
              Authorization: token,
            },
          });
          return { status: res.status };
        },
        { token: BEARER_TOKEN, body: TEST_BODY },
      );

      expect(result.status).toBe(403);
    },
  );
});

// ─── /api/custom-explicit-auth ────────────────────────────────────────────────
// Custom origin request policy: all viewer headers except Host (Authorization included).
// This is equivalent to ALL_VIEWER_EXCEPT_HOST_HEADER but implemented as a custom policy.
// OAC still signs the request and Lambda still strips the Authorization header.

test.describe("/api/custom-explicit-auth — Custom policy, all except Host (Authorization forwarded)", () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test(
    "POST with Authorization → 200, OAC signing proven (custom policy, Authorization in denyList)",
    async ({ page }) => {
      const result = await page.evaluate(
        async ({ token, body }) => {
          const res = await window.signedFetch(location.origin + "/api/custom-explicit-auth", {
            method: "POST",
            body,
            headers: {
              "Content-Type": "application/json",
              Authorization: token,
            },
          });
          return { status: res.status, body: await res.json() };
        },
        { token: BEARER_TOKEN, body: TEST_BODY },
      );

      expect(result.status).toBe(200);
      expect(result.body.hashMatch).toBe(true);

      // Same result as ALL_VIEWER_EXCEPT_HOST_HEADER: OAC signs, Lambda strips Authorization.
      // The custom policy's inclusion of Authorization in the forwarded set makes no
      // observable difference — the Lambda Function URL runtime always strips it.
      assertOacSigned(result.body.receivedHeaders);
    },
  );
});

// ─── /api/custom-no-auth ─────────────────────────────────────────────────────
// Custom origin request policy that explicitly EXCLUDES Authorization from the
// forwarded headers (using denyList("host", "authorization")).
// FINDING: The result is identical — Lambda still doesn't see Authorization,
// and OAC signing headers (x-amz-date, x-amz-security-token etc.) still appear.
// OAC injects its SigV4 Authorization independently of the origin request policy.

test.describe("/api/custom-no-auth — Custom policy, Authorization excluded from forwarding", () => {
  test.beforeEach(async ({ page }) => {
    await loadHarness(page);
  });

  test(
    "POST with Authorization → 200, same OAC signing proof (policy exclusion makes no difference)",
    async ({ page }) => {
      const result = await page.evaluate(
        async ({ token, body }) => {
          const res = await window.signedFetch(location.origin + "/api/custom-no-auth", {
            method: "POST",
            body,
            headers: {
              "Content-Type": "application/json",
              Authorization: token,
            },
          });
          return { status: res.status, body: await res.json() };
        },
        { token: BEARER_TOKEN, body: TEST_BODY },
      );

      expect(result.status).toBe(200);
      expect(result.body.hashMatch).toBe(true);

      // Excluding Authorization from the origin request policy has no effect on OAC.
      // OAC always generates and sends its own SigV4 Authorization for the origin request.
      // Lambda Function URL always strips it. The end result is identical to all other
      // working behaviors.
      assertOacSigned(result.body.receivedHeaders);
    },
  );

  test(
    "POST without Authorization → 200, OAC signing still happens (no client auth needed for OAC)",
    async ({ page }) => {
      // With no client Authorization header and the policy excluding it from forwarding,
      // the origin request still gets OAC SigV4 signing — OAC generates it independently.
      const result = await page.evaluate(async (body) => {
        const res = await window.signedFetch(location.origin + "/api/custom-no-auth", {
          method: "POST",
          body,
          headers: { "Content-Type": "application/json" },
          // No Authorization header from client
        });
        return { status: res.status, body: await res.json() };
      }, TEST_BODY);

      expect(result.status).toBe(200);
      assertOacSigned(result.body.receivedHeaders);
    },
  );
});
