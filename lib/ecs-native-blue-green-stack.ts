import * as cdk from "aws-cdk-lib/core";
import { aws_applicationsignals as applicationsignals } from "aws-cdk-lib";
import { Construct } from "constructs";
import { VpcConstruct } from "./construct/vpc-construct";
import { AlbConstruct } from "./construct/alb-construct";
import { FirelensConstruct } from "./construct/firelens-construct";
import { EcsConstruct } from "./construct/ecs-construct";
import { AuroraConstruct } from "./construct/aurora-construct";
import { ValkeyConstruct } from "./construct/valkey-construct";
import { ApprovalLambdaConstruct } from "./construct/approval-lambda-construct";
import { QDeveloperChatConstruct } from "./construct/q-developer-chat-construct";

export interface EcsNativeBlueGreenStackProps extends cdk.StackProps {
  slackWorkspaceId: string;
  slackChannelId: string;
}

export class EcsNativeBlueGreenStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: EcsNativeBlueGreenStackProps
  ) {
    super(scope, id, props);

    const vpcConstruct = new VpcConstruct(this, "VpcConstruct");

    // Aurora PostgreSQL Serverless v2
    const auroraConstruct = new AuroraConstruct(this, "AuroraConstruct", {
      vpc: vpcConstruct.vpc,
      // minCapacity: 0, maxCapacity: 1 がデフォルト
    });

    // ElastiCache for Valkey Serverless
    const valkeyConstruct = new ValkeyConstruct(this, "ValkeyConstruct", {
      vpc: vpcConstruct.vpc,
    });

    const albConstruct = new AlbConstruct(this, "AlbConstruct", {
      vpc: vpcConstruct.vpc,
    });
    const firelensConstruct = new FirelensConstruct(this, "FirelensConstruct");

    // Approval Lambda Construct（S3バケットを先に作成）
    const approvalLambda = new ApprovalLambdaConstruct(this, "ApprovalLambda");

    // Q Developer Chat Construct（S3バケットARNを渡す）
    const qDeveloperChat = new QDeveloperChatConstruct(this, "QDeveloperChat", {
      slackWorkspaceId: props.slackWorkspaceId,
      slackChannelId: props.slackChannelId,
      approvalBucketArn: approvalLambda.approvalBucket.bucketArn,
    });

    // LambdaにSNS Topic publish権限を付与
    qDeveloperChat.notificationTopic.grantPublish(
      approvalLambda.approvalFunction
    );

    // Lambda環境変数にSNS Topic ARNを設定
    approvalLambda.approvalFunction.addEnvironment(
      "SNS_TOPIC_ARN",
      qDeveloperChat.notificationTopic.topicArn
    );

    const ecsConstruct = new EcsConstruct(this, "EcsConstruct", {
      vpc: vpcConstruct.vpc,
      alb: albConstruct.alb,
      tg1: albConstruct.tg1,
      tg2: albConstruct.tg2,
      listenerRule: albConstruct.listenerRule,
      testListenerRule: albConstruct.testListenerRule,
      firelens: {
        deliveryStream: firelensConstruct.deliveryStream,
        logGroup: firelensConstruct.firelensLogGroup,
        confBucket: firelensConstruct.firelensConfBucket,
      },
      enableFluentBitMetrics: true,
      // Aurora接続設定
      aurora: {
        cluster: auroraConstruct.cluster,
        secret: auroraConstruct.secret,
      },
      // Valkey接続設定
      valkey: {
        endpoint: valkeyConstruct.endpoint,
        port: valkeyConstruct.port,
        securityGroup: valkeyConstruct.securityGroup,
      },
      // Application Signals有効化
      enableApplicationSignals: true,
      approvalFunction: approvalLambda.approvalFunction,
    });
  }
}
