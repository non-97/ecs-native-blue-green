import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface QDeveloperChatConstructProps {
  slackWorkspaceId: string;
  slackChannelId: string;
}

/**
 * Amazon Q Developer in chat applications (旧AWS Chatbot) のカスタムアクション設定
 * ECS Blue/Greenデプロイメントの承認/拒否ボタンを提供
 *
 * 承認: SSM Parameterの値を approved に更新
 * 拒否: SSM Parameterの値を rejected に更新
 *
 * パラメータ名: /ecs/<cluster>/<service>/ecs-native-blue-green-approval/<revisionId>
 * $parameterName = SSMパラメータ名 (通知のadditionalContextから取得)
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
    const ssmParameterArn = `arn:aws:ssm:${region}:${account}:parameter/ecs/*/*/ecs-native-blue-green-approval/*`;

    // SNS Topic for deployment notifications
    const notificationTopic = new cdk.aws_sns.Topic(
      this,
      "DeploymentNotificationTopic"
    );
    this.notificationTopic = notificationTopic;

    // IAM Role for Amazon Q Developer in chat applications
    const chatbotRole = new cdk.aws_iam.Role(this, "ChatbotRole", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("chatbot.amazonaws.com"),
    });

    // SSM PutParameter権限（承認/拒否ステータス更新用）
    chatbotRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ["ssm:PutParameter"],
        resources: [ssmParameterArn],
      })
    );

    // ガードレールポリシー（カスタムアクションのCLIコマンド実行に必要）
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

    // Slack Channel Configuration
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

    // カスタムアクション1: POST_TEST_TRAFFIC_SHIFT 承認
    const approveAction = new cdk.aws_chatbot.CfnCustomAction(
      this,
      "PostTestTrafficShiftApproveAction",
      {
        actionName: "PostTestTrafficShiftApprove",
        aliasName: "post-test-traffic-approve",
        definition: {
          commandText:
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

    // カスタムアクション2: POST_TEST_TRAFFIC_SHIFT 拒否
    const rejectAction = new cdk.aws_chatbot.CfnCustomAction(
      this,
      "PostTestTrafficShiftRejectAction",
      {
        actionName: "PostTestTrafficShiftReject",
        aliasName: "post-test-traffic-reject",
        definition: {
          commandText:
            "ssm put-parameter --name $parameterName --value rejected --type String --region $region",
        },
        attachments: [
          {
            buttonText: "❌ ロールバック",
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

    // カスタムアクションをチャンネル設定に関連付け
    const cfnSlackChannel = slackChannel.node
      .defaultChild as cdk.aws_chatbot.CfnSlackChannelConfiguration;
    cfnSlackChannel.customizationResourceArns = [
      approveAction.ref,
      rejectAction.ref,
    ];
  }
}
