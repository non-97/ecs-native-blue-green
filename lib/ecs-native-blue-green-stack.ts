import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import { VpcConstruct } from "./construct/vpc-construct";
import { AlbConstruct } from "./construct/alb-construct";
import { FirelensConstruct } from "./construct/firelens-construct";
import { EcsConstruct } from "./construct/ecs-construct";

export class EcsNativeBlueGreenStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpcConstruct = new VpcConstruct(this, "VpcConstruct");
    const albConstruct = new AlbConstruct(this, "AlbConstruct", {
      vpc: vpcConstruct.vpc,
    });
    const firelensConstruct = new FirelensConstruct(this, "FirelensConstruct");
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
    });
  }
}
