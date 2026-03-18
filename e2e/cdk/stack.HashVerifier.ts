import { createHash } from "crypto";
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";

export const handler = async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
  const method = event.requestContext.http.method;
  const body = event.body || "";
  const rawBody = event.isBase64Encoded ? Buffer.from(body, "base64") : Buffer.from(body);

  const receivedHash = event.headers["x-amz-content-sha256"] || "";
  const computedHash = createHash("sha256").update(rawBody).digest("hex");

  // Echo all received headers so tests can inspect what Lambda saw after OAC signing.
  // In particular, the `authorization` header will contain the OAC SigV4 signature,
  // proving that CloudFront OAC overwrites any client-provided Authorization value.
  const result = {
    method,
    bodyLength: rawBody.length,
    rawBody: rawBody.toString("utf-8"),
    receivedHash,
    computedHash,
    hashMatch: receivedHash === computedHash,
    receivedHeaders: event.headers,
  };

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  };
};
