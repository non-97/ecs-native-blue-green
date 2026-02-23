import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";

/**
 * ECS Blue/Green Deployment ライフサイクルフック用Lambda
 *
 * POST_TEST_TRAFFIC_SHIFT フックから呼び出され、以下の処理を行う:
 *
 * 1. 初回デプロイ(Blue環境なし)の場合は即SUCCEEDED
 * 2. フック初回呼び出し時にSNS経由でSlack通知を送信
 * 3. 2回目以降はSSM Parameterの値をポーリングして承認/拒否を判定
 *    - approved → SUCCEEDED(本番トラフィックを再ルーティング)
 *    - rejected → FAILED(ロールバック)
 * 4. 承認/拒否確定後にSSMパラメータを削除(クリーンアップ)
 *
 * SSMパラメータはカスタムアクションボタン(Amazon Q Developer in chat applications)の
 * CLIコマンドで作成されるため、Lambda側では事前作成しない。
 *
 * パラメータ名: /ecs/<cluster>/<service>/ecs-native-blue-green-approval/<revisionId>
 * SNS Topic ARNはスタック側でaddEnvironment()により環境変数に設定する。
 */
export class ApprovalLambdaConstruct extends Construct {
  public readonly approvalFunction: cdk.aws_lambda.Function;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;

    // SSMパラメータのARNパターン
    // ワイルドカードでクラスター名/サービス名/リビジョンIDを許可
    const ssmParameterArn = `arn:aws:ssm:${region}:${account}:parameter/ecs/*/*/ecs-native-blue-green-approval/*`;

    // Lambda Powertools Layer (Python 3.13 ARM64)
    const powertoolsLayer = cdk.aws_lambda.LayerVersion.fromLayerVersionArn(
      this,
      "PowertoolsLayer",
      `arn:aws:lambda:${region}:017000801446:layer:AWSLambdaPowertoolsPythonV3-python313-arm64:19`
    );

    // ライフサイクルフックハンドラLambda
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
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        layers: [powertoolsLayer],
        environment: {
          POWERTOOLS_SERVICE_NAME: "ecs-blue-green-approval",
          POWERTOOLS_LOG_LEVEL: "INFO",
          LOG_LEVEL: "INFO",
        },
      }
    );

    // SSM Parameter Store権限
    // GetParameter: 承認ステータスのポーリング用
    // DeleteParameter: 承認/拒否確定後のクリーンアップ用
    this.approvalFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:DeleteParameter"],
        resources: [ssmParameterArn],
      })
    );

    // ECS読み取り権限
    // DescribeServices: 初回デプロイ判定 + ベイクタイム取得
    // ListServiceDeployments: サービスデプロイメントID取得(コンソールURL構築用)
    this.approvalFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ["ecs:DescribeServices", "ecs:ListServiceDeployments"],
        resources: ["*"],
      })
    );
  }
}
