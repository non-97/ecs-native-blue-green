import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface QDeveloperChatConstructProps {
  slackWorkspaceId: string;
  slackChannelId: string;
  /** 通知配信元の SNS Topic (Step Functions が Publish する) */
  notificationTopic: cdk.aws_sns.ITopic;
}

/**
 * Amazon Q Developer in chat applications (旧AWS Chatbot) によるSlack連携
 *
 * ECS Blue/Green Deployment の PAUSE ライフサイクルフック (POST_TEST_TRAFFIC_SHIFT) と連携し、
 * Slackチャンネルにカスタムアクションボタン付きの通知を送信する。
 *
 * カスタムアクションボタンの動作:
 *   - 「再ルーティング」ボタン: aws ecs continue-service-deployment --hook-id $hookId --action CONTINUE
 *   - 「ロールバック」ボタン  : aws ecs continue-service-deployment --hook-id $hookId --action ROLLBACK
 *
 * $hookId / $region はSNS通知の additionalContext から展開される。
 *
 * ボタン表示条件(criteria):
 *   - hookId変数に値が存在すること(HAS_VALUE)
 *   - ActionGroup変数が "ecs-blue-green-deployment_POST_TEST_TRAFFIC_SHIFT" であること(EQUALS)
 *
 * 注意: commandText では先頭の "aws" は不要。
 */
export class QDeveloperChatConstruct extends Construct {
  readonly slackChannel: cdk.aws_chatbot.SlackChannelConfiguration;

  constructor(
    scope: Construct,
    id: string,
    props: QDeveloperChatConstructProps
  ) {
    super(scope, id);

    // Amazon Q Developer in chat applications が使用するIAMロール
    // カスタムアクションボタンのCLIコマンド実行時にこのロールが使われる
    const chatbotRole = new cdk.aws_iam.Role(this, "ChatbotRole", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("chatbot.amazonaws.com"),
    });

    // ecs:ContinueServiceDeployment は hookId ベースの API で
    // リソースレベル制限が効かないため Resource: "*" を許可する
    chatbotRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ["ecs:ContinueServiceDeployment"],
        resources: ["*"],
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
            actions: ["ecs:ContinueServiceDeployment"],
            resources: ["*"],
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
        notificationTopics: [props.notificationTopic],
        role: chatbotRole,
        guardrailPolicies: [guardrailPolicy],
        loggingLevel: cdk.aws_chatbot.LoggingLevel.INFO,
        userRoleRequired: false,
      }
    );
    this.slackChannel = slackChannel;

    // カスタムアクション1: POST_TEST_TRAFFIC_SHIFT 承認(本番トラフィックを再ルーティング)
    const postTestTrafficShiftApproveAction =
      new cdk.aws_chatbot.CfnCustomAction(
        this,
        "PostTestTrafficShiftApproveAction",
        {
          actionName: "PostTestTrafficShiftApprove",
          aliasName: "post-test-traffic-approve",
          definition: {
            // 先頭に `aws` は不要
            commandText:
              "ecs continue-service-deployment --service-deployment-arn $serviceDeploymentArn --hook-id $hookId --action CONTINUE --region $region",
          },
          attachments: [
            {
              buttonText: "🔁 再ルーティング",
              notificationType: "Custom",
              criteria: [
                {
                  operator: "HAS_VALUE",
                  variableName: "hookId",
                },
                {
                  operator: "EQUALS",
                  variableName: "ActionGroup",
                  value: "ecs-blue-green-deployment_POST_TEST_TRAFFIC_SHIFT",
                },
              ],
              variables: {
                ActionGroup: "event.metadata.additionalContext.ActionGroup",
                hookId: "event.metadata.additionalContext.hookId",
                serviceDeploymentArn:
                  "event.metadata.additionalContext.serviceDeploymentArn",
                region: "event.metadata.additionalContext.region",
              },
            },
          ],
        }
      );

    // カスタムアクション2: POST_TEST_TRAFFIC_SHIFT 拒否(ロールバック)
    const postTestTrafficShiftRejectAction =
      new cdk.aws_chatbot.CfnCustomAction(
        this,
        "PostTestTrafficShiftRejectAction",
        {
          actionName: "PostTestTrafficShiftReject",
          aliasName: "post-test-traffic-reject",
          definition: {
            // 先頭に `aws` は不要
            commandText:
              "ecs continue-service-deployment --service-deployment-arn $serviceDeploymentArn --hook-id $hookId --action ROLLBACK --region $region",
          },
          attachments: [
            {
              buttonText: "⏪ ロールバック",
              notificationType: "Custom",
              criteria: [
                {
                  operator: "HAS_VALUE",
                  variableName: "hookId",
                },
                {
                  operator: "EQUALS",
                  variableName: "ActionGroup",
                  value: "ecs-blue-green-deployment_POST_TEST_TRAFFIC_SHIFT",
                },
              ],
              variables: {
                ActionGroup: "event.metadata.additionalContext.ActionGroup",
                hookId: "event.metadata.additionalContext.hookId",
                serviceDeploymentArn:
                  "event.metadata.additionalContext.serviceDeploymentArn",
                region: "event.metadata.additionalContext.region",
              },
            },
          ],
        }
      );

    // カスタムアクションをSlackチャンネル設定に関連付け
    const cfnSlackChannel = slackChannel.node
      .defaultChild as cdk.aws_chatbot.CfnSlackChannelConfiguration;
    cfnSlackChannel.customizationResourceArns = [
      postTestTrafficShiftApproveAction.ref,
      postTestTrafficShiftRejectAction.ref,
    ];
  }
}
