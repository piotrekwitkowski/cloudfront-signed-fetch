import { App } from "aws-cdk-lib";
import { E2eStack } from "./stack";

const app = new App();
new E2eStack(app, "CloudfrontSignedFetchE2e");
