#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { EcsNativeBlueGreenStack } from "../lib/ecs-native-blue-green-stack";

const app = new cdk.App();

// メインスタック: ECS Blue/Green デプロイメント環境
// Amazon Q Developer in chat applications、S3ポーリング式承認Lambda、
// Lifecycle Hookがすべて含まれています
new EcsNativeBlueGreenStack(app, "EcsNativeBlueGreenStack", {
  slackWorkspaceId: "T0A74KE0G78",
  slackChannelId: "C0A76LPE6FL",
});
