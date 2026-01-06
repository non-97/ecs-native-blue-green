import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";

export interface EcsConstructProps {
  vpc: cdk.aws_ec2.IVpc;
  alb: cdk.aws_elasticloadbalancingv2.IApplicationLoadBalancer;
  tg2: cdk.aws_elasticloadbalancingv2.IApplicationTargetGroup;
  tg1: cdk.aws_elasticloadbalancingv2.IApplicationTargetGroup;
  listenerRule: cdk.aws_elasticloadbalancingv2.ApplicationListenerRule;
  testListenerRule: cdk.aws_elasticloadbalancingv2.ApplicationListenerRule;
}

export class EcsConstruct extends Construct {
  constructor(scope: Construct, id: string, props: EcsConstructProps) {
    super(scope, id);
    const containerName = "Main";

    // VPC
    const vpc = props.vpc;

    // ECS Cluster
    const cluster = new cdk.aws_ecs.Cluster(this, "Cluster", {
      vpc,
    });

    // // Task Execution Role
    // const executionRole = new cdk.aws_iam.Role(this, "TaskExecutionRole", {
    //   assumedBy: new cdk.aws_iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    //   managedPolicies: [
    //     cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
    //       "service-role/AmazonECSTaskExecutionRolePolicy"
    //     ),
    //   ],
    // });

    // Task Definition
    const taskDefinition = new cdk.aws_ecs.FargateTaskDefinition(
      this,
      "TaskDefinition",
      {
        cpu: 256,
        memoryLimitMiB: 512,
        runtimePlatform: {
          cpuArchitecture: cdk.aws_ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: cdk.aws_ecs.OperatingSystemFamily.LINUX,
        },
      }
    );

    // Container
    taskDefinition.addContainer("Container", {
      containerName,
      image: cdk.aws_ecs.ContainerImage.fromAsset(
        path.join(__dirname, `../../container/${containerName}`),
        {
          platform: cdk.aws_ecr_assets.Platform.LINUX_ARM64,
        }
      ),
      essential: true,
      portMappings: [{ containerPort: 80 }],
    });

    // ECS Service
    const service = new cdk.aws_ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      deploymentStrategy: cdk.aws_ecs.DeploymentStrategy.BLUE_GREEN,
      bakeTime: cdk.Duration.minutes(3),
      vpcSubnets: vpc.selectSubnets({
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }),
      circuitBreaker: { rollback: true },
    });
    service.connections.allowFrom(props.alb, cdk.aws_ec2.Port.tcp(80));

    const target = service.loadBalancerTarget({
      containerName,
      containerPort: 80,
      protocol: cdk.aws_ecs.Protocol.TCP,
      alternateTarget: new cdk.aws_ecs.AlternateTarget("AlternateTarget", {
        alternateTargetGroup: props.tg2,
        productionListener:
          cdk.aws_ecs.ListenerRuleConfiguration.applicationListenerRule(
            props.listenerRule
          ),
        testListener:
          cdk.aws_ecs.ListenerRuleConfiguration.applicationListenerRule(
            props.testListenerRule
          ),
      }),
    });
    target.attachToApplicationTargetGroup(props.tg1);
  }
}
