import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface AlbConstructProps {
  vpc: cdk.aws_ec2.IVpc;
}

export class AlbConstruct extends Construct {
  readonly alb: cdk.aws_elasticloadbalancingv2.IApplicationLoadBalancer;
  readonly tg1: cdk.aws_elasticloadbalancingv2.IApplicationTargetGroup;
  readonly tg2: cdk.aws_elasticloadbalancingv2.IApplicationTargetGroup;
  readonly listenerRule: cdk.aws_elasticloadbalancingv2.ApplicationListenerRule;
  readonly testListenerRule: cdk.aws_elasticloadbalancingv2.ApplicationListenerRule;

  constructor(scope: Construct, id: string, props: AlbConstructProps) {
    super(scope, id);

    const vpc = props.vpc;

    // ALB
    const alb = new cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer(
      this,
      "Default",
      {
        vpc: vpc,
        internetFacing: true,
        vpcSubnets: vpc.selectSubnets({
          subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
        }),
      }
    );
    this.alb = alb;

    // Target Group
    const tg1 = new cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup(
      this,
      "Tg1",
      {
        vpc: vpc,
        protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
        targetType: cdk.aws_elasticloadbalancingv2.TargetType.IP,
        healthCheck: {
          path: "/",
          port: "80",
          protocol: cdk.aws_elasticloadbalancingv2.Protocol.HTTP,
        },
      }
    );
    this.tg1 = tg1;

    const tg2 = new cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup(
      this,
      "Tg2",
      {
        vpc: vpc,
        protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
        targetType: cdk.aws_elasticloadbalancingv2.TargetType.IP,
        healthCheck: {
          path: "/",
          port: "80",
          protocol: cdk.aws_elasticloadbalancingv2.Protocol.HTTP,
        },
      }
    );
    this.tg2 = tg2;

    // ALB Listener
    const listener = alb.addListener("Listener", {
      port: 80,
      protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [tg1],
    });

    const listenerRule =
      new cdk.aws_elasticloadbalancingv2.ApplicationListenerRule(
        this,
        "ListenerRule",
        {
          listener,
          priority: 1,
          conditions: [
            cdk.aws_elasticloadbalancingv2.ListenerCondition.pathPatterns([
              "*",
            ]),
          ],
          action: cdk.aws_elasticloadbalancingv2.ListenerAction.forward([tg1]),
        }
      );
    this.listenerRule = listenerRule;

    const testListener = alb.addListener("TestListener", {
      port: 10080,
      protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [tg2],
    });

    const testListenerRule =
      new cdk.aws_elasticloadbalancingv2.ApplicationListenerRule(
        this,
        "TestListenerRule",
        {
          listener: testListener,
          priority: 1,
          conditions: [
            cdk.aws_elasticloadbalancingv2.ListenerCondition.pathPatterns([
              "*",
            ]),
          ],
          action: cdk.aws_elasticloadbalancingv2.ListenerAction.forward([tg2]),
        }
      );
    this.testListenerRule = testListenerRule;
  }
}
