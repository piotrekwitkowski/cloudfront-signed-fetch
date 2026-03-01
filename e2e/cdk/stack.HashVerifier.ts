import { createHash } from "crypto";
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";

export const handler = async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
  const method = event.requestContext.http.method;
  const body = event.body || "";
  const rawBody = event.isBase64Encoded ? Buffer.from(body, "base64") : Buffer.from(body);

  const receivedHash = event.headers["x-amz-content-sha256"] || "";
  const computedHash = createHash("sha256").update(rawBody).digest("hex");

  const result = {
    method,
    bodyLength: rawBody.length,
    receivedHash,
    computedHash,
    hashMatch: receivedHash === computedHash,
  };

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  };
};
