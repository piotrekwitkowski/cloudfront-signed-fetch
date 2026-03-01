import { describe, it, expect, vi, beforeEach } from "vitest";
import { signedFetch } from "./index.js";

const TEST_URL = "https://example.cloudfront.net/api";

// Pre-computed SHA-256 hashes for test assertions
const HASH_OF_HELLO = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const HASH_OF_EMPTY_JSON = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"; // {}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
  );
});

describe("signedFetch", () => {
  describe("header behavior", () => {
    it("sets x-amz-content-sha256 when body is present", async () => {
      await signedFetch(TEST_URL, { method: "POST", body: "hello" });

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBe(HASH_OF_HELLO);
    });

    it("does not set x-amz-content-sha256 when no body", async () => {
      await signedFetch(TEST_URL, { method: "GET" });

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.has("x-amz-content-sha256")).toBe(false);
    });

    it("does not set x-amz-content-sha256 when init is undefined", async () => {
      await signedFetch(TEST_URL);

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.has("x-amz-content-sha256")).toBe(false);
    });

    it("sets empty hash for POST without body", async () => {
      await signedFetch(TEST_URL, { method: "POST" });

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      );
    });

    it("sets empty hash for PUT without body", async () => {
      await signedFetch(TEST_URL, { method: "PUT" });

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      );
    });

    it("sets empty hash for PATCH without body", async () => {
      await signedFetch(TEST_URL, { method: "PATCH" });

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      );
    });

    it("preserves existing headers", async () => {
      await signedFetch(TEST_URL, {
        method: "POST",
        body: "hello",
        headers: { "Content-Type": "text/plain", Authorization: "Bearer tok" },
      });

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("Content-Type")).toBe("text/plain");
      expect(headers.get("Authorization")).toBe("Bearer tok");
      expect(headers.get("x-amz-content-sha256")).toBe(HASH_OF_HELLO);
    });
  });

  describe("hash correctness by body type", () => {
    it("hashes string body", async () => {
      await signedFetch(TEST_URL, { method: "POST", body: "hello" });

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBe(HASH_OF_HELLO);
    });

    it("hashes JSON string body", async () => {
      await signedFetch(TEST_URL, {
        method: "PUT",
        body: JSON.stringify({}),
      });

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBe(HASH_OF_EMPTY_JSON);
    });

    it("hashes ArrayBuffer body", async () => {
      const buf = new TextEncoder().encode("hello").buffer as ArrayBuffer;
      await signedFetch(TEST_URL, { method: "POST", body: buf });

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBe(HASH_OF_HELLO);
    });

    it("hashes Uint8Array body", async () => {
      const arr = new TextEncoder().encode("hello");
      await signedFetch(TEST_URL, { method: "POST", body: arr });

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBe(HASH_OF_HELLO);
    });

    it("hashes Blob body", async () => {
      const blob = new Blob(["hello"]);
      await signedFetch(TEST_URL, { method: "POST", body: blob });

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBe(HASH_OF_HELLO);
    });

    it("hashes URLSearchParams body", async () => {
      const params = new URLSearchParams({ key: "value" });
      await signedFetch(TEST_URL, { method: "POST", body: params });

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBeTruthy();
      expect(headers.get("x-amz-content-sha256")).toHaveLength(64);
    });

    it("hashes ReadableStream body", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      });
      await signedFetch(TEST_URL, {
        method: "POST",
        body: stream,
        // @ts-expect-error duplex is required for streaming but not in all TS types
        duplex: "half",
      });

      const call = vi.mocked(fetch).mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBe(HASH_OF_HELLO);
    });
  });

  describe("fetch passthrough", () => {
    it("passes input and init to fetch", async () => {
      await signedFetch(TEST_URL, { method: "DELETE" });

      expect(fetch).toHaveBeenCalledOnce();
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(TEST_URL);
      expect(call[1]?.method).toBe("DELETE");
    });

    it("returns the fetch response", async () => {
      const res = await signedFetch(TEST_URL);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    });
  });
});
