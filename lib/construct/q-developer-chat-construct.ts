import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface QDeveloperChatConstructProps {
  slackWorkspaceId: string;
  slackChannelId: string;
}

/**
 * Amazon Q Developer in chat applications (旧AWS Chatbot) によるSlack連携
 *
 * ECS Blue/Green Deploymentのライフサイクルフック(POST_TEST_TRAFFIC_SHIFT)と連携し、
 * Slackチャンネルにカスタムアクションボタン付きの通知を送信する。
 *
 * カスタムアクションボタンの動作:
 * - 「再ルーティング」ボタン: SSM Parameterを "approved" で作成
 * - 「ロールバック」ボタン: SSM Parameterを "rejected" で作成
 *
 * ボタン押下時に実行されるCLIコマンド:
 *   ssm put-parameter --name $parameterName --value approved/rejected --type String --region $region
 *
 * $parameterName, $region はSNS通知のadditionalContextから展開される。
 * パラメータ名: /ecs/<cluster>/<service>/ecs-native-blue-green-approval/<revisionId>
 *
 * ボタン表示条件(criteria):
 * - parameterName変数に値が存在すること(HAS_VALUE)
 * - ActionGroup変数が "ecs-blue-green-deployment_POST_TEST_TRAFFIC_SHIFT" であること(EQUALS)
 *
 * 注意: commandTextでは --overwrite フラグを使用しない。
 * --overwriteを指定するとAmazon Q DeveloperがCLIコマンドを実行せずにAIが解説する動作になるため。
 * (--overwrite boolean の場合は正常にAWS CLIが動作する)
 */
export class QDeveloperChatConstruct extends Construct {
  readonly slackChannel: cdk.aws_chatbot.SlackChannelConfiguration;
  readonly notificationTopic: cdk.aws_sns.ITopic;

  constructor(
    scope: Construct,
    id: string,
    props: QDeveloperChatConstructProps
  ) {
    super(scope, id);

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;

    // SSMパラメータのARNパターン(ワイルドカードでクラスター名・サービス名・リビジョンIDを許可)
    const ssmParameterArn = `arn:aws:ssm:${region}:${account}:parameter/ecs/*/*/ecs-native-blue-green-approval/*`;

    // Lambda関数からのSNS Publish先となるトピック
    const notificationTopic = new cdk.aws_sns.Topic(
      this,
      "DeploymentNotificationTopic"
    );
    this.notificationTopic = notificationTopic;

    // Amazon Q Developer in chat applicationsが使用するIAMロール
    // カスタムアクションボタンのCLIコマンド実行時にこのロールが使われる
    const chatbotRole = new cdk.aws_iam.Role(this, "ChatbotRole", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("chatbot.amazonaws.com"),
    });

    // チャンネルロールにSSM PutParameter権限を付与
    // カスタムアクションボタンから ssm put-parameter を実行するために必要
    chatbotRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ["ssm:PutParameter"],
        resources: [ssmParameterArn],
      })
    );

    // ガードレールポリシー
    // カスタムアクションのCLIコマンド実行にはチャンネルロールの権限に加えて
    // ガードレールポリシーでも同じ権限を許可する必要がある
    const guardrailPolicy = new cdk.aws_iam.ManagedPolicy(
      this,
      "ChatbotGuardrailPolicy",
      {
        statements: [
          new cdk.aws_iam.PolicyStatement({
            effect: cdk.aws_iam.Effect.ALLOW,
            actions: ["ssm:PutParameter"],
            resources: [ssmParameterArn],
          }),
        ],
      }
    );

    // Slackチャンネル設定
    const slackChannel = new cdk.aws_chatbot.SlackChannelConfiguration(
      this,
      "SlackChannel",
      {
        slackChannelConfigurationName: "ecs-blue-green-deployment",
        slackWorkspaceId: props.slackWorkspaceId,
        slackChannelId: props.slackChannelId,
        notificationTopics: [notificationTopic],
        role: chatbotRole,
        guardrailPolicies: [guardrailPolicy],
        loggingLevel: cdk.aws_chatbot.LoggingLevel.INFO,
        userRoleRequired: false,
      }
    );
    this.slackChannel = slackChannel;

    // カスタムアクション1: POST_TEST_TRAFFIC_SHIFT 承認(本番トラフィックを再ルーティング)
    // ボタン押下でSSMパラメータを "approved" で新規作成する
    const postTestTrafficShiftApproveAction =
      new cdk.aws_chatbot.CfnCustomAction(
        this,
        "PostTestTrafficShiftApproveAction",
        {
          actionName: "PostTestTrafficShiftApprove",
          aliasName: "post-test-traffic-approve",
          definition: {
            commandText:
              // 先頭に `aws` は不要
              "ssm put-parameter --name $parameterName --value approved --type String --region $region",
          },
          attachments: [
            {
              buttonText: "🔁 再ルーティング",
              notificationType: "Custom",
              criteria: [
                {
                  operator: "HAS_VALUE",
                  variableName: "parameterName",
                },
                {
                  operator: "EQUALS",
                  variableName: "ActionGroup",
                  value: "ecs-blue-green-deployment_POST_TEST_TRAFFIC_SHIFT",
                },
              ],
              variables: {
                ActionGroup: "event.metadata.additionalContext.ActionGroup",
                parameterName: "event.metadata.additionalContext.parameterName",
                region: "event.metadata.additionalContext.region",
              },
            },
          ],
        }
      );

    // カスタムアクション2: POST_TEST_TRAFFIC_SHIFT 拒否(ロールバック)
    // ボタン押下でSSMパラメータを "rejected" で新規作成する
    const postTestTrafficShiftRejectAction =
      new cdk.aws_chatbot.CfnCustomAction(
        this,
        "PostTestTrafficShiftRejectAction",
        {
          actionName: "PostTestTrafficShiftReject",
          aliasName: "post-test-traffic-reject",
          definition: {
            commandText:
              // 先頭に `aws` は不要
              "ssm put-parameter --name $parameterName --value rejected --type String --region $region",
          },
          attachments: [
            {
              buttonText: "⏪ ロールバック",
              notificationType: "Custom",
              criteria: [
                {
                  operator: "HAS_VALUE",
                  variableName: "parameterName",
                },
                {
                  operator: "EQUALS",
                  variableName: "ActionGroup",
                  value: "ecs-blue-green-deployment_POST_TEST_TRAFFIC_SHIFT",
                },
              ],
              variables: {
                ActionGroup: "event.metadata.additionalContext.ActionGroup",
                parameterName: "event.metadata.additionalContext.parameterName",
                region: "event.metadata.additionalContext.region",
              },
            },
          ],
        }
      );

    // カスタムアクションをSlackチャンネル設定に関連付け
    // L1コンストラクト(CfnSlackChannelConfiguration)経由で設定する必要がある
    const cfnSlackChannel = slackChannel.node
      .defaultChild as cdk.aws_chatbot.CfnSlackChannelConfiguration;
    cfnSlackChannel.customizationResourceArns = [
      postTestTrafficShiftApproveAction.ref,
      postTestTrafficShiftRejectAction.ref,
    ];
  }
}
