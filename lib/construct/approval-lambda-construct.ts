import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";

/**
 * ECS Blue/Green Deployment承認用Lambda（SSM Parameter Storeポーリング方式）
 *
 * SSM Parameterの値を確認して承認/拒否を判定する。
 * - approved → SUCCEEDED
 * - rejected → FAILED
 *
 * パラメータ名: /ecs/<cluster>/<service>/ecs-native-blue-green-approval/<revisionId>
 * SNS Topic ARNはスタック側でaddEnvironment()で設定する。
 */
export class ApprovalLambdaConstruct extends Construct {
  public readonly approvalFunction: cdk.aws_lambda.Function;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;
    const ssmParameterArn = `arn:aws:ssm:${region}:${account}:parameter/ecs/*/*/ecs-native-blue-green-approval/*`;

    // Lambda Powertools Layer
    const powertoolsLayer = cdk.aws_lambda.LayerVersion.fromLayerVersionArn(
      this,
      "PowertoolsLayer",
      `arn:aws:lambda:${region}:017000801446:layer:AWSLambdaPowertoolsPythonV3-python313-arm64:19`
    );

    // Lambda Function
    this.approvalFunction = new cdk.aws_lambda.Function(
      this,
      "ApprovalFunction",
      {
        runtime: cdk.aws_lambda.Runtime.PYTHON_3_13,
        handler: "index.handler",
        code: cdk.aws_lambda.Code.fromAsset(
          path.join(__dirname, "../../lambda/approval-handler")
        ),
        architecture: cdk.aws_lambda.Architecture.ARM_64,
        timeout: cdk.Duration.minutes(15),
        memorySize: 512,
        layers: [powertoolsLayer],
        environment: {
          POWERTOOLS_SERVICE_NAME: "ecs-blue-green-approval",
          POWERTOOLS_LOG_LEVEL: "INFO",
          LOG_LEVEL: "INFO",
        },
      }
    );

    // SSM Parameter Store権限（パラメータ作成・取得・削除用）
    this.approvalFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:DeleteParameter"],
        resources: [ssmParameterArn],
      })
    );

    // ECS読み取り権限（サービス情報取得用）
    this.approvalFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ["ecs:DescribeServices", "ecs:DescribeTaskDefinition"],
        resources: ["*"],
      })
    );
  }
}
