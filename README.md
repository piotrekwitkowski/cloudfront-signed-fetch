# cloudfront-signed-fetch

## Problem

When CloudFront uses OAC (Origin Access Control) to sign requests to Lambda Function URLs with SigV4, it does **not** compute the SHA-256 hash of the request body for POST/PUT requests. Lambda Function URLs don't support unsigned payloads — they require the `x-amz-content-sha256` header to contain the actual hash of the body.

From the [AWS documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html):

> If you use `PUT` or `POST` methods with your Lambda function URL, your users must compute the SHA256 of the body and include the payload hash value of the request body in the `x-amz-content-sha256` header when sending the request to CloudFront. Lambda doesn't support unsigned payloads.

This means **POST/PUT requests will fail** unless the client computes and sends this header. CloudFront passes it through to the origin, but the responsibility is entirely on the caller.

## Why it matters

Without the `x-amz-content-sha256` header, any POST/PUT request through CloudFront OAC to a Lambda Function URL will be rejected by Lambda. This isn't an optional integrity check — it's a hard requirement for the request to succeed.

Common workarounds involve computing the hash server-side (e.g., Lambda@Edge on the origin request), but:

- Lambda@Edge truncates request bodies at ~1 MB
- Lambda Function URLs accept up to 6 MB
- This creates a gap where payloads between 1–6 MB cannot be hashed by Lambda@Edge

The only reliable solution is to compute the hash on the client before sending the request.

## Proposed solution

A lightweight browser-compatible wrapper around the Fetch API that:

1. Computes the SHA-256 hash of the request body using the Web Crypto API (`crypto.subtle.digest`)
2. Attaches it as the `x-amz-content-sha256` header on every request
3. Maintains the same API surface as `fetch()` — drop-in replacement

## Constraints

- Must work in browsers (no Node.js `crypto` module)
- Must handle all body types (`string`, `ArrayBuffer`, `ReadableStream`, `FormData`, etc.)
- The `x-amz-content-sha256` header is non-standard, so it triggers CORS preflights — the origin must include it in `Access-Control-Allow-Headers`
- This does **not** replace SigV4 signing — CloudFront OAC handles that. This library only provides the payload hash that Lambda requires
