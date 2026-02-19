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
                operator: "HAS_VALUE",
                variableName: "bucketName",
              },
              {
                operator: "HAS_VALUE",
                variableName: "revisionId",
              },
            ],
            variables: {
              bucketName: "metadata.additionalContext.bucketName",
              revisionId: "metadata.additionalContext.revisionId",
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
                operator: "HAS_VALUE",
                variableName: "bucketName",
              },
              {
                operator: "HAS_VALUE",
                variableName: "revisionId",
              },
            ],
            variables: {
              bucketName: "metadata.additionalContext.bucketName",
              revisionId: "metadata.additionalContext.revisionId",
            },
          },
        ],
      }
    );

    slackChannel.node.addDependency(approveAction);
    slackChannel.node.addDependency(rejectAction);
  }
}
