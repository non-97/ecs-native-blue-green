import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface ChatbotConstructProps {}

export class ChatbotConstruct extends Construct {
  readonly vpc: cdk.aws_ec2.IVpc;

  constructor(scope: Construct, id: string, props?: ChatbotConstructProps) {
    super(scope, id);

    const slackChannel = new cdk.aws_chatbot.SlackChannelConfiguration(
      this,
      "Default",
      {
        slackChannelConfigurationName: "ecs-native-blue-green-deploy",
        slackWorkspaceId: "T08PKK443CL",
        slackChannelId: "C0A7DUCFTCZ",
      }
    );
  }
}
