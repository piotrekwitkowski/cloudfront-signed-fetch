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

    // Lambda: hash verification handler
    const fn = new NodejsFunction(this, "HashVerifier", {
      runtime: lambda.Runtime.NODEJS_LATEST,
    });
    fn.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // Function URL with IAM auth
    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // Read the built signedFetch bundle to inline in the test page
    const bundlePath = path.join(__dirname, "..", "..", "dist", "index.js");
    if (!fs.existsSync(bundlePath)) {
      throw new Error("dist/index.js not found. Run `npm run build` first.");
    }
    const signedFetchBundle = fs.readFileSync(bundlePath, "utf-8");

    // CloudFront Function: serves test page on /test
    const testPageHtml = `<!DOCTYPE html>
<html><head><title>e2e test</title></head>
<body>
<script type="module">
${signedFetchBundle}
window.signedFetch = signedFetch;
</script>
</body></html>`;

    const cfFunction = new cloudfront.Function(this, "TestPageFunction", {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  if (event.request.uri === '/test') {
    return {
      statusCode: 200,
      statusDescription: 'OK',
      headers: { 'content-type': { value: 'text/html' } },
      body: ${JSON.stringify(testPageHtml)}
    };
  }
  return event.request;
}
      `),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    // CloudFront distribution with OAC
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.FunctionUrlOrigin.withOriginAccessControl(fnUrl),
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy:
          cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        functionAssociations: [
          {
            function: cfFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
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
