import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { BucketConstruct } from "./bucket-construct";
import * as path from "path";

export interface EcsConstructProps {
  vpc: cdk.aws_ec2.IVpc;
  alb: cdk.aws_elasticloadbalancingv2.IApplicationLoadBalancer;
  tg2: cdk.aws_elasticloadbalancingv2.IApplicationTargetGroup;
  tg1: cdk.aws_elasticloadbalancingv2.IApplicationTargetGroup;
  listenerRule: cdk.aws_elasticloadbalancingv2.ApplicationListenerRule;
  testListenerRule: cdk.aws_elasticloadbalancingv2.ApplicationListenerRule;
  firelens?: {
    deliveryStream: cdk.aws_kinesisfirehose.IDeliveryStream;
    logGroup: cdk.aws_logs.ILogGroup;
    confBucket: cdk.aws_s3.IBucket;
  };
}

export class EcsConstruct extends Construct {
  constructor(scope: Construct, id: string, props: EcsConstructProps) {
    super(scope, id);

    // VPC
    const vpc = props.vpc;

    // ECS Exec log destinations
    const ecsExecLogBucketConstruct = new BucketConstruct(
      this,
      "ecsExecLogBucketConstruct"
    );

    // ECS Cluster
    const cluster = new cdk.aws_ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsightsV2: cdk.aws_ecs.ContainerInsights.ENHANCED,
      executeCommandConfiguration: {
        logConfiguration: {
          s3Bucket: ecsExecLogBucketConstruct.bucket,
          s3EncryptionEnabled: true,
        },
        logging: cdk.aws_ecs.ExecuteCommandLogging.OVERRIDE,
      },
    });

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
    const webContainer = taskDefinition.addContainer("WebContainer", {
      containerName: "web",
      image: cdk.aws_ecs.ContainerImage.fromAsset(
        path.join(__dirname, "../../src/container/web"),
        {
          platform: cdk.aws_ecr_assets.Platform.LINUX_ARM64,
        }
      ),
      essential: true,
      portMappings: [{ containerPort: 80 }],
      linuxParameters: new cdk.aws_ecs.LinuxParameters(
        this,
        "WebLinuxParameters",
        {
          initProcessEnabled: true,
        }
      ),
      logging: props.firelens
        ? cdk.aws_ecs.LogDrivers.firelens({})
        : cdk.aws_ecs.LogDrivers.awsLogs({
            streamPrefix: "web",
          }),
    });

    const appContainer = taskDefinition.addContainer("AppContainer", {
      containerName: "app",
      image: cdk.aws_ecs.ContainerImage.fromAsset(
        path.join(__dirname, "../../src/container/app"),
        {
          platform: cdk.aws_ecr_assets.Platform.LINUX_ARM64,
        }
      ),
      essential: true,
      healthCheck: {
        command: [
          "CMD-SHELL",
          "wget -q  -O - http://localhost:3000/health || exit 1",
        ],
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(3),
        retries: 3,
        startPeriod: cdk.Duration.seconds(5),
      },
      linuxParameters: new cdk.aws_ecs.LinuxParameters(
        this,
        "AppLinuxParameters",
        {
          initProcessEnabled: true,
        }
      ),
      logging: props.firelens
        ? cdk.aws_ecs.LogDrivers.firelens({})
        : cdk.aws_ecs.LogDrivers.awsLogs({
            streamPrefix: "app",
          }),
    });

    webContainer.addContainerDependencies({
      container: appContainer,
      condition: cdk.aws_ecs.ContainerDependencyCondition.HEALTHY,
    });

    if (props.firelens) {
      taskDefinition.addFirelensLogRouter("logRouter", {
        image: cdk.aws_ecs.ContainerImage.fromRegistry(
          "public.ecr.aws/aws-observability/aws-for-fluent-bit:init-3.1.1"
        ),
        essential: true,
        logging: cdk.aws_ecs.LogDrivers.awsLogs({
          streamPrefix: `firelens/${taskDefinition.family}`,
        }),
        firelensConfig: {
          type: cdk.aws_ecs.FirelensLogRouterType.FLUENTBIT,
        },
        environment: {
          LOG_GROUP_NAME: props.firelens.logGroup.logGroupName,
          FIREHOSE_DELIVERY_STREAM_NAME:
            props.firelens.deliveryStream.deliveryStreamName,
          aws_fluent_bit_init_s3_1: `${props.firelens.confBucket.bucketArn}/extra.conf`,
          aws_fluent_bit_init_s3_2: `${props.firelens.confBucket.bucketArn}/parsers_custom.conf`,
        },
      });
      props.firelens.confBucket.grantRead(taskDefinition.taskRole);
      props.firelens.deliveryStream.grantPutRecords(taskDefinition.taskRole);
      props.firelens.logGroup.grantWrite(taskDefinition.taskRole);
    }
    ecsExecLogBucketConstruct.bucket.grantPut(taskDefinition.taskRole);

    // ECS Service
    const service = new cdk.aws_ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      deploymentStrategy: cdk.aws_ecs.DeploymentStrategy.BLUE_GREEN,
      bakeTime: cdk.Duration.minutes(1),
      vpcSubnets: vpc.selectSubnets({
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }),
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(10),
      enableExecuteCommand: true,
    });
    service.connections.allowFrom(props.alb, cdk.aws_ec2.Port.tcp(80));

    const target = service.loadBalancerTarget({
      containerName: webContainer.containerName,
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
