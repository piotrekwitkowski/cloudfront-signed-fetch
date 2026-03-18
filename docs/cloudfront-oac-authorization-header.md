# Does CloudFront OAC Overwrite the Client's Authorization Header?

**TL;DR:** With `SigningBehavior: always` — yes, OAC unconditionally overwrites `Authorization` with SigV4. But you can't directly observe it: Lambda Function URLs with `AWS_IAM` auth strip the `Authorization` header before your handler code ever sees it, regardless of signing behavior. OAC signing is real and provable, just via different headers.

---

## Background

[`cloudfront-signed-fetch`](https://github.com/piwit/cloudfront-signed-fetch) is a small library that wraps `fetch()` and computes the `x-amz-content-sha256` header for `POST`/`PUT`/`PATCH` requests going through CloudFront OAC to Lambda Function URLs. Without that header, CloudFront's SigV4 signing fails and the request is rejected.

While building it, a question came up: **what happens to a client-provided `Authorization` header?** For example, if you send `Authorization: Bearer my-token` through CloudFront, does OAC preserve it, overwrite it, or do something else entirely?

These two headers serve completely different purposes:

- **`x-amz-content-sha256`** — the SHA-256 hash of the request body, required by Lambda Function URLs + OAC so CloudFront can include it in the SigV4 signature. The client computes and provides it; CloudFront passes it through to the origin.
- **`Authorization`** — used both by clients for custom auth (e.g., `Bearer` tokens) and by OAC for SigV4 signing of the origin request. These are two entirely different uses of the same header name.

The concern was: can you use CloudFront Functions to validate a bearer token at the edge (viewer-request stage) and still have OAC correctly sign the origin request? Or does one clobber the other?

---

## The Experiment

We extended the e2e test infrastructure to answer this directly. The setup:

- **Lambda Function URL** with `AWS_IAM` auth type (the origin)
- **CloudFront** in front, with OAC (`SigningBehavior: always`, SigV4)
- **Lambda handler** echoes back all of `event.headers` plus the body hash result
- **Five cache behaviors** each using a different origin request policy or CloudFront Function, to isolate variables

**Scope:** all five behaviors use `SigningBehavior: always` — the CDK default for `FunctionUrlOrigin.withOriginAccessControl()`. OAC has three signing modes and they behave very differently with respect to `Authorization`:

| SigningBehavior | What OAC does to Authorization | Use when |
|---|---|---|
| `always` | Always overwrites with SigV4 — unconditionally, regardless of what the client sent | Lambda Function URLs with AWS_IAM (the only valid choice here) |
| `no-override` | Signs with SigV4 _only if_ the request has no Authorization header. If the client sent one, OAC leaves it and forwards it as-is | Origins where you want the client to optionally supply their own auth |
| `never` | Never signs — passes the request through unsigned. Client's Authorization reaches the origin untouched | Origins that handle their own auth entirely |

Note: with Lambda Function URLs + `AWS_IAM` auth, `always` is the only practical choice. `never` means Lambda rejects every request with 403 (no SigV4). `no-override` with a client-supplied `Authorization` header means OAC skips signing, so Lambda also rejects with 403.

### Behavior matrix

| Path | Origin Request Policy | CloudFront Function (viewer-request) | Purpose |
|------|-----------------------|--------------------------------------|---------|
| `/api/no-auth` | Managed `ALL_VIEWER_EXCEPT_HOST_HEADER` | None | Baseline |
| `/api/auth-required` | Managed `ALL_VIEWER_EXCEPT_HOST_HEADER` | Auth gate: requires `Bearer 1234` | Does CF Function see the client's token? Does OAC overwrite it? |
| `/api/all-viewer` | Managed `ALL_VIEWER` (includes `Host`) | None | Does forwarding `Host` matter? |
| `/api/custom-explicit-auth` | Custom: all headers except `Host` | None | Does explicitly including `Authorization` in the policy change anything? |
| `/api/custom-no-auth` | Custom: all headers except `Host` and `Authorization` | None | If the policy excludes `Authorization`, does OAC still sign? |

The CloudFront Function on `/api/auth-required` checks the `Authorization` header at the viewer-request stage — before OAC gets involved — and returns 401 if the value isn't exactly `Bearer 1234`.

---

## Results

### Finding 1: The CloudFront Function sees the client's original `Authorization` header

The CF Function on `/api/auth-required` correctly enforces the bearer token. Send `Authorization: Bearer 1234` → 200. Send anything else (or nothing) on a `POST`/`PUT`/`PATCH` → 401, at the edge, before the request ever reaches Lambda.

This confirms the pattern works: **you can validate custom auth at the viewer-request stage using a CloudFront Function, even when OAC is going to sign the origin request afterward.**

```
Client → [Authorization: Bearer 1234] → CloudFront Function (viewer-request)
                                                  ↓ passes through
                                         OAC signs origin request with SigV4
                                                  ↓
                                         Lambda Function URL (validates SigV4)
```

The CF Function and OAC each operate on the `Authorization` header at different stages and for different purposes. They don't interfere with each other.

### Finding 2: Lambda Function URL strips `Authorization` from `event.headers`

This was the most surprising result. After a successful POST through `/api/auth-required` with `Authorization: Bearer 1234`, the handler's `event.headers` contained no `authorization` key at all — not the client's `Bearer 1234` value, and not the OAC SigV4 value either.

This is intentional. Lambda Function URLs with `AWS_IAM` auth type **consume and discard the `Authorization` header** as part of SigV4 validation. The runtime validates the signature, then strips the header before invoking the handler. Your code never sees it.

So the original question — "does OAC overwrite the client's Authorization header?" — is answered indirectly: **yes, OAC replaces it with SigV4 on the origin request, but Lambda then strips it entirely before the handler runs.** The client's original token is gone either way.

### Finding 3: OAC signing is proven via the `x-amz-*` headers

Even though `authorization` is absent from `event.headers`, the handler receives four headers that OAC injects as part of SigV4 signing:

```json
{
  "x-amz-date": "20260316T001851Z",
  "x-amz-security-token": "IQoJb3JpZ2luX2VjEA...",
  "x-amz-source-account": "159594200080",
  "x-amz-source-arn": "arn:aws:cloudfront::159594200080:distribution/E2C44L7OVKRQ6N"
}
```

These are the proof that OAC signed the request. The `x-amz-security-token` is the temporary credential from the OAC-assumed IAM role; `x-amz-source-arn` identifies the distribution. If OAC hadn't signed the request, Lambda would have rejected it with 403 — the request wouldn't have reached the handler at all.

### Finding 4: `ALL_VIEWER` origin request policy is incompatible with OAC + Lambda Function URL

The `/api/all-viewer` behavior, which uses the managed `ALL_VIEWER` policy (forwards all viewer headers including `Host`), returned **403 AccessDeniedException** for every request.

The reason: when the `Host` header is forwarded to the Lambda Function URL origin, OAC includes the viewer's `Host` value (the CloudFront domain, e.g. `d1ijebef4s6q77.cloudfront.net`) in the SigV4 signature. But the actual request is sent to the Lambda Function URL's hostname (e.g. `urjw325b...lambda-url.us-east-1.on.aws`). The signed Host and the actual Host don't match — signature verification fails.

**Use `ALL_VIEWER_EXCEPT_HOST_HEADER` (or a custom `denyList("host")` policy) with Lambda Function URL origins.** This is the managed policy the CDK `FunctionUrlOrigin.withOriginAccessControl()` recommends and what the existing behavior uses correctly.

### Finding 5: Custom origin request policies make no observable difference for `Authorization`

Whether the custom policy explicitly includes `Authorization` in the forwarded headers (`/api/custom-explicit-auth`) or explicitly excludes it (`/api/custom-no-auth`), the result is identical:

- The request reaches Lambda (200)
- `event.headers.authorization` is absent (stripped by the runtime)
- `x-amz-date`, `x-amz-security-token`, `x-amz-source-account`, `x-amz-source-arn` are present (OAC signed it)
- `x-amz-content-sha256` matches the body hash (`hashMatch: true`)

OAC generates and injects its SigV4 `Authorization` independently of what the origin request policy says about `Authorization`. The policy controls what viewer headers are forwarded — but OAC's own signing is orthogonal to that.

---

## The Full Flow, Annotated

```
Browser
  │
  │  signedFetch(url, { method: 'POST', body, headers: { Authorization: 'Bearer 1234' } })
  │  → sets x-amz-content-sha256: <sha256(body)>
  │  → preserves Authorization: Bearer 1234
  │
  ▼
CloudFront Edge (viewer-request stage)
  │
  ├─ CloudFront Function [/api/auth-required only]
  │    Sees Authorization: Bearer 1234 ✓ → passes through
  │    (If missing or wrong → returns 401 immediately, never reaches origin)
  │
  ▼
CloudFront OAC (before forwarding to origin)
  │
  ├─ Applies origin request policy (strips Host, optionally strips Authorization)
  ├─ Computes SigV4 signature over: method + URL + headers + x-amz-content-sha256
  ├─ Sets Authorization: AWS4-HMAC-SHA256 Credential=.../SignedHeaders=...
  │   (overwrites the client's Bearer 1234)
  ├─ Sets x-amz-date, x-amz-security-token
  │
  ▼
Lambda Function URL (AWS_IAM auth validation)
  │
  ├─ Validates SigV4 signature in Authorization header ✓
  ├─ Strips Authorization from event.headers  ← key behavior
  │
  ▼
Handler (event.headers)
  ├─ authorization: [ABSENT — stripped by Lambda runtime]
  ├─ x-amz-content-sha256: <sha256(body)>   ← passed through unchanged ✓
  ├─ x-amz-date: 20260316T001851Z           ← OAC signing proof
  ├─ x-amz-security-token: IQoJb3...        ← OAC signing proof
  ├─ x-amz-source-account: 159594200080     ← OAC signing proof
  └─ x-amz-source-arn: arn:aws:cloudfront::... ← OAC signing proof
```

---

## Conclusions

| Question | Answer |
|----------|--------|
| Does OAC overwrite the client's `Authorization` header? | Yes, with `always` — unconditionally replaces with SigV4. With `no-override`, only if the client didn't send one. With `never`, not at all. |
| Can a CloudFront Function validate a bearer token before OAC signs? | Yes — CF Function runs at viewer-request stage, before OAC |
| Can my Lambda handler read the client's original `Authorization` value? | No — Lambda Function URL strips it before the handler runs |
| Can my Lambda handler read the OAC SigV4 `Authorization` value? | No — same stripping applies |
| How do I prove OAC signed the request in my handler? | Check for `x-amz-date`, `x-amz-security-token`, `x-amz-source-account`, `x-amz-source-arn` |
| Does the origin request policy's treatment of `Authorization` matter? | No — OAC signing is orthogonal to the forwarding policy |
| Should I use `ALL_VIEWER` policy with Lambda Function URL + OAC? | No — it breaks SigV4 because the `Host` header mismatches. Use `ALL_VIEWER_EXCEPT_HOST_HEADER` |
| Does `x-amz-content-sha256` pass through unchanged? | Yes — in all working behaviors |

---

## Code

The full test infrastructure is in the [`cloudfront-signed-fetch`](https://github.com/piwit/cloudfront-signed-fetch) repo:

- **`e2e/cdk/stack.ts`** — CDK stack defining all five behaviors
- **`e2e/cdk/stack.HashVerifier.ts`** — Lambda handler that echoes `event.headers`
- **`e2e/tests/auth-overwrite.spec.ts`** — Playwright tests codifying all findings
- **`test.sh`** — curl-based manual test script

To reproduce:

```bash
npm run e2e:deploy   # deploys CloudFront + Lambda stack (~4 minutes)
npm run e2e:test     # runs Playwright tests against the live distribution
./test.sh            # manual curl probes with pretty-printed output
npm run e2e:destroy  # tears down the stack when done
```
