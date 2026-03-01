# cloudfront-signed-fetch

A drop-in `fetch()` wrapper that computes the `x-amz-content-sha256` header required for POST/PUT/PATCH requests through CloudFront OAC to Lambda Function URLs.

## Problem

When CloudFront uses OAC (Origin Access Control) to sign requests to Lambda Function URLs with SigV4, it does **not** compute the SHA-256 hash of the request body. Lambda Function URLs don't support unsigned payloads — they require the `x-amz-content-sha256` header to contain the actual hash of the body.

From the [AWS documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html):

> If you use `PUT` or `POST` methods with your Lambda function URL, your users must compute the SHA256 of the body and include the payload hash value of the request body in the `x-amz-content-sha256` header when sending the request to CloudFront. Lambda doesn't support unsigned payloads.

Without this header, **POST/PUT requests will fail**. CloudFront passes the header through to the origin, but the responsibility is entirely on the caller.

Common workarounds involve computing the hash server-side (e.g., Lambda@Edge on the origin request), but Lambda@Edge truncates request bodies at ~1 MB while Lambda Function URLs accept up to 6 MB — creating a gap where larger payloads cannot be hashed at the edge.

## Install

```bash
npm install cloudfront-signed-fetch
```

## Usage

```typescript
import { signedFetch } from "cloudfront-signed-fetch";

// Use exactly like fetch() — the header is added automatically for write methods
const res = await signedFetch("https://d111111abcdef8.cloudfront.net/api", {
  method: "POST",
  body: JSON.stringify({ hello: "world" }),
  headers: { "Content-Type": "application/json" },
});
```

## Behavior

- **POST, PUT, PATCH** — computes SHA-256 of the body (or empty hash if no body) and sets `x-amz-content-sha256`
- **GET, HEAD, DELETE** — no header added, request passes through unchanged
- All `BodyInit` types are supported: `string`, `ArrayBuffer`, `Blob`, `FormData`, `URLSearchParams`, `ReadableStream`, and typed arrays
- Uses the Web Crypto API (`crypto.subtle.digest`) — works in all modern browsers and Web Workers

## Notes

- This does **not** replace SigV4 signing — CloudFront OAC handles that. This library only provides the payload hash that Lambda requires.
- When your frontend is served from the same CloudFront distribution as the API (recommended), requests are same-origin and the custom header does not trigger CORS preflights.
- If making cross-origin requests, the origin must include `x-amz-content-sha256` in `Access-Control-Allow-Headers`.

## E2E testing

The `e2e/` directory contains a CDK stack and Playwright tests that validate the library against a real CloudFront + Lambda Function URL deployment.

```bash
npm run e2e:deploy   # deploy CDK stack (CloudFront + Lambda + OAC)
npm run e2e:test     # run Playwright tests against the distribution
npm run e2e:destroy  # tear down the stack
npm run e2e          # all three in sequence
```

The test page is served directly from a CloudFront Function — no S3 bucket needed. The built `signedFetch` bundle is inlined in the HTML.
