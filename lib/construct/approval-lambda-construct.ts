import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";

/**
 * ECS Blue/Green Deployment承認用Lambda（S3ポーリング方式）
 *
 * S3バケットに承認/拒否オブジェクトが配置されるまでポーリングする。
 * - {revision_id}/approved → SUCCEEDED
 * - {revision_id}/rejected → FAILED
 *
 * SNS Topic ARNはスタック側でaddEnvironment()で設定する。
 */
export class ApprovalLambdaConstruct extends Construct {
  public readonly approvalFunction: cdk.aws_lambda.Function;
  public readonly approvalBucket: cdk.aws_s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // S3バケット（承認/拒否オブジェクト用）
    this.approvalBucket = new cdk.aws_s3.Bucket(this, "ApprovalBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
    });

    // Lambda Powertools Layer
    const powertoolsLayer = cdk.aws_lambda.LayerVersion.fromLayerVersionArn(
      this,
      "PowertoolsLayer",
      `arn:aws:lambda:${
        cdk.Stack.of(this).region
      }:017000801446:layer:AWSLambdaPowertoolsPythonV3-python313-arm64:19`
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
          S3_BUCKET_NAME: this.approvalBucket.bucketName,
          POWERTOOLS_SERVICE_NAME: "ecs-blue-green-approval",
          POWERTOOLS_LOG_LEVEL: "INFO",
          LOG_LEVEL: "INFO",
        },
      }
    );

    // S3読み取り権限（承認/拒否チェック用）
    this.approvalBucket.grantRead(this.approvalFunction);

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
