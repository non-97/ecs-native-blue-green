#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { EcsNativeBlueGreenStack } from "../lib/ecs-native-blue-green-stack";

const app = new cdk.App();
new EcsNativeBlueGreenStack(app, "EcsNativeBlueGreenStack");
