
async function toArrayBuffer(body: BodyInit): Promise<ArrayBuffer> {
  if (typeof body === "string") {
    return new TextEncoder().encode(body).buffer as ArrayBuffer;
  }
  if (body instanceof ArrayBuffer) {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength
    ) as ArrayBuffer;
  }
  if (body instanceof Blob) {
    return body.arrayBuffer();
  }
  if (body instanceof FormData || body instanceof URLSearchParams) {
    // Let the browser serialize it the same way fetch would
    return new Response(body).arrayBuffer();
  }
  if (body instanceof ReadableStream) {
    return new Response(body).arrayBuffer();
  }
  // Fallback for any other BodyInit type
  return new Response(body as BodyInit).arrayBuffer();
}

const EMPTY_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function payloadHash(body?: BodyInit | null): Promise<string> {
  return body
    ? sha256Hex(await toArrayBuffer(body))
    : EMPTY_HASH;
}

export async function signedFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers);

  if (WRITE_METHODS.has(init?.method?.toUpperCase()!)) {
    headers.set("x-amz-content-sha256", await payloadHash(init?.body));
  }

  return fetch(input, { ...init, headers });
}
