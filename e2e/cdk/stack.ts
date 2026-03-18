import { Stack, StackProps, CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import { Construct } from "constructs";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class E2eStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const fn = new NodejsFunction(this, "HashVerifier", {
      runtime: lambda.Runtime.NODEJS_LATEST,
    });
    fn.applyRemovalPolicy(RemovalPolicy.DESTROY);

    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    const lambdaOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl);

    const bundlePath = path.join(__dirname, "..", "..", "dist", "index.js");
    if (!fs.existsSync(bundlePath)) {
      throw new Error("dist/index.js not found. Run `npm run build` first.");
    }
    const signedFetchBundle = fs.readFileSync(bundlePath, "utf-8");

    const testPageHtml = `<!DOCTYPE html>
<html><head><title>e2e test harness</title></head>
<body>
<script type="module">
${signedFetchBundle}
window.signedFetch = signedFetch;
</script>
</body></html>`;

    const testPageFunction = new cloudfront.Function(this, "TestPageFunction", {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  return {
    statusCode: 200,
    statusDescription: 'OK',
    headers: { 'content-type': { value: 'text/html' } },
    body: ${JSON.stringify(testPageHtml)}
  };
}
      `),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    // Enforces Authorization: Bearer 1234 on POST/PUT/PATCH at viewer-request stage.
    // Runs BEFORE OAC signing — sees the client's original header.
    const authCheckFunction = new cloudfront.Function(this, "AuthCheckFunction", {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var req = event.request;
  var method = req.method;

  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    var authHeader = req.headers['authorization'];
    var token = authHeader ? authHeader.value : '';

    if (token !== 'Bearer 1234') {
      return {
        statusCode: 401,
        statusDescription: 'Unauthorized',
        headers: { 'content-type': { value: 'application/json' } },
        body: JSON.stringify({ error: 'Missing or invalid Authorization header. Expected: Bearer 1234' })
      };
    }
  }

  return req;
}
      `),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    const commonBehavior = {
      origin: lambdaOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
    };

    // Forwards all viewer headers except Host (Authorization included via denyList).
    // OAC always overwrites Authorization with SigV4 regardless.
    const customPolicyWithAuth = new cloudfront.OriginRequestPolicy(this, "CustomPolicyWithAuth", {
      originRequestPolicyName: `${this.stackName}-custom-with-auth`,
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.denyList("host"),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
    });

    // Forwards all viewer headers except Host AND Authorization.
    // OAC still injects its own SigV4 Authorization on the origin request.
    const customPolicyNoAuth = new cloudfront.OriginRequestPolicy(this, "CustomPolicyNoAuth", {
      originRequestPolicyName: `${this.stackName}-custom-no-auth`,
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.denyList("host", "authorization"),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: lambdaOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        functionAssociations: [
          {
            function: testPageFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },

      additionalBehaviors: {
        "/api/no-auth": {
          ...commonBehavior,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },

        "/api/auth-required": {
          ...commonBehavior,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [
            {
              function: authCheckFunction,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },

        "/api/all-viewer": {
          ...commonBehavior,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },

        "/api/custom-explicit-auth": {
          ...commonBehavior,
          originRequestPolicy: customPolicyWithAuth,
        },

        "/api/custom-no-auth": {
          ...commonBehavior,
          originRequestPolicy: customPolicyNoAuth,
        },
      },
    });

    new CfnOutput(this, "DistributionUrl", {
      value: `https://${distribution.distributionDomainName}`,
    });

    new CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
    });
  }
}
