import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface QDeveloperChatConstructProps {
  slackWorkspaceId: string;
  slackChannelId: string;
  approvalBucketArn: string;
}

/**
 * Amazon Q Developer in chat applications (旧AWS Chatbot) のカスタムアクション設定
 * ECS Blue/Greenデプロイメントの承認/拒否ボタンを提供
 *
 * 承認: S3バケットに {revisionId}/approved オブジェクトを配置
 * 拒否: S3バケットに {revisionId}/rejected オブジェクトを配置
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

    // S3 PutObject権限（承認/拒否オブジェクト配置用）
    chatbotRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ["s3:PutObject"],
        resources: [`${props.approvalBucketArn}/*`],
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
            actions: ["s3:PutObject"],
            resources: [`${props.approvalBucketArn}/*`],
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

    // カスタムアクション1: 承認（S3にapprovedオブジェクトを配置）
    const approveAction = new cdk.aws_chatbot.CfnCustomAction(
      this,
      "ApproveDeploymentAction",
      {
        actionName: "ApproveEcsDeployment",
        aliasName: "approve-ecs-deployment",
        definition: {
          commandText: `aws s3api put-object --bucket $bucketName --key "$revisionId/approved"`,
        },
        attachments: [
          {
            buttonText: "✅ 承認",
            notificationType: "Custom",
            criteria: [
              {
                operator: "EQUALS",
                variableName: "ActionGroup",
                value: "ecs-blue-green-deployment",
              },
            ],
            variables: {
              ActionGroup:
                "event.metadata.additionalContext.ActionGroup",
              bucketName:
                "event.metadata.additionalContext.bucketName",
              revisionId:
                "event.metadata.additionalContext.revisionId",
            },
          },
        ],
      }
    );

    // カスタムアクション2: 拒否（S3にrejectedオブジェクトを配置）
    const rejectAction = new cdk.aws_chatbot.CfnCustomAction(
      this,
      "RejectDeploymentAction",
      {
        actionName: "RejectEcsDeployment",
        aliasName: "reject-ecs-deployment",
        definition: {
          commandText: `aws s3api put-object --bucket $bucketName --key "$revisionId/rejected"`,
        },
        attachments: [
          {
            buttonText: "❌ 拒否",
            notificationType: "Custom",
            criteria: [
              {
                operator: "EQUALS",
                variableName: "ActionGroup",
                value: "ecs-blue-green-deployment",
              },
            ],
            variables: {
              ActionGroup:
                "event.metadata.additionalContext.ActionGroup",
              bucketName:
                "event.metadata.additionalContext.bucketName",
              revisionId:
                "event.metadata.additionalContext.revisionId",
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
