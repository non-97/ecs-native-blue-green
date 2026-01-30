import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { BucketConstruct } from "./bucket-construct";
import * as path from "path";
import * as fs from "fs";

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
  enableFluentBitMetrics?: boolean;
  aurora?: {
    cluster: cdk.aws_rds.IDatabaseCluster;
    secret: cdk.aws_secretsmanager.ISecret;
  };
  valkey?: {
    endpoint: string;
    port: number;
    securityGroup: cdk.aws_ec2.ISecurityGroup;
  };
  enableApplicationSignals?: boolean;
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

    // Application Signals用: 自動計装ライブラリの共有ボリューム
    if (props.enableApplicationSignals) {
      taskDefinition.addVolume({
        name: "opentelemetry-auto-instrumentation",
      });

      // init コンテナ: 自動計装ライブラリを共有ボリュームにコピー
      const initContainer = taskDefinition.addContainer("InitContainer", {
        containerName: "init",
        image: cdk.aws_ecs.ContainerImage.fromRegistry(
          "public.ecr.aws/aws-observability/adot-autoinstrumentation-node:v0.8.0"
        ),
        essential: false,
        command: [
          "cp",
          "-r",
          "/autoinstrumentation/.",
          "/otel-auto-instrumentation/",
        ],
        logging: cdk.aws_ecs.LogDrivers.awsLogs({
          streamPrefix: "init",
        }),
      });

      initContainer.addMountPoints({
        sourceVolume: "opentelemetry-auto-instrumentation",
        containerPath: "/otel-auto-instrumentation",
        readOnly: false,
      });
    }

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

    // appコンテナの環境変数
    const appEnvironment: Record<string, string> = {};
    const appSecrets: Record<string, cdk.aws_ecs.Secret> = {};

    // Valkey接続設定
    if (props.valkey) {
      appEnvironment["VALKEY_HOST"] = props.valkey.endpoint;
      appEnvironment["VALKEY_PORT"] = props.valkey.port.toString();
      appEnvironment["VALKEY_TLS"] = "true";
    }

    if (props.enableApplicationSignals) {
      appEnvironment["NODE_OPTIONS"] =
        "--require /otel-auto-instrumentation/autoinstrumentation.js";
      appEnvironment["OTEL_RESOURCE_ATTRIBUTES"] =
        "service.name=express-app,deployment.environment=production";
      appEnvironment["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://localhost:4317";
      appEnvironment["OTEL_EXPORTER_OTLP_PROTOCOL"] = "grpc";
      appEnvironment["OTEL_TRACES_EXPORTER"] = "otlp";
      appEnvironment["OTEL_METRICS_EXPORTER"] = "none";
      appEnvironment["OTEL_LOGS_EXPORTER"] = "none";
      appEnvironment["OTEL_TRACES_SAMPLER"] = "parentbased_always_on";
      appEnvironment["OTEL_PROPAGATORS"] = "tracecontext,baggage,xray";
    }

    // Aurora接続設定（Secrets Manager経由）
    // シークレットの各フィールドを個別に取得し、アプリ側でDATABASE_URLを構築
    if (props.aurora) {
      appSecrets["DB_HOST"] = cdk.aws_ecs.Secret.fromSecretsManager(
        props.aurora.secret,
        "host"
      );
      appSecrets["DB_PORT"] = cdk.aws_ecs.Secret.fromSecretsManager(
        props.aurora.secret,
        "port"
      );
      appSecrets["DB_USERNAME"] = cdk.aws_ecs.Secret.fromSecretsManager(
        props.aurora.secret,
        "username"
      );
      appSecrets["DB_PASSWORD"] = cdk.aws_ecs.Secret.fromSecretsManager(
        props.aurora.secret,
        "password"
      );
      appSecrets["DB_NAME"] = cdk.aws_ecs.Secret.fromSecretsManager(
        props.aurora.secret,
        "dbname"
      );
    }

    const appContainer = taskDefinition.addContainer("AppContainer", {
      containerName: "app",
      image: cdk.aws_ecs.ContainerImage.fromAsset(
        path.join(__dirname, "../../src/container/app"),
        {
          platform: cdk.aws_ecr_assets.Platform.LINUX_ARM64,
        }
      ),
      essential: true,
      environment: appEnvironment,
      secrets: appSecrets,
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

    if (props.enableApplicationSignals) {
      appContainer.addMountPoints({
        sourceVolume: "opentelemetry-auto-instrumentation",
        containerPath: "/otel-auto-instrumentation",
        readOnly: true,
      });

      const initContainer = taskDefinition.findContainer("init");
      if (initContainer) {
        appContainer.addContainerDependencies({
          container: initContainer,
          condition: cdk.aws_ecs.ContainerDependencyCondition.SUCCESS,
        });
      }
    }

    webContainer.addContainerDependencies({
      container: appContainer,
      condition: cdk.aws_ecs.ContainerDependencyCondition.HEALTHY,
    });

    if (props.firelens) {
      const logRouterContainer = taskDefinition.addFirelensLogRouter(
        "logRouter",
        {
          image: cdk.aws_ecs.ContainerImage.fromRegistry(
            "public.ecr.aws/aws-observability/aws-for-fluent-bit:init-3.2.0"
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
        }
      );
      props.firelens.confBucket.grantRead(taskDefinition.taskRole);
      props.firelens.deliveryStream.grantPutRecords(taskDefinition.taskRole);
      props.firelens.logGroup.grantWrite(taskDefinition.taskRole);

      if (props.enableFluentBitMetrics || props.enableApplicationSignals) {
        const otelConfigPath = props.enableApplicationSignals
          ? "../../src/otel-config/otel-app-signals.yaml"
          : "../../src/otel-config/otel-config.yaml";
        const otelConfig = fs.readFileSync(
          path.join(__dirname, otelConfigPath),
          "utf-8"
        );
        const otelConfigParameter = new cdk.aws_ssm.StringParameter(
          this,
          "OtelConfig",
          {
            parameterName: `/ecs/${cdk.Names.uniqueId(this)}/otel-config`,
            stringValue: otelConfig,
          }
        );

        // ADOTコンテナを追加
        const otelContainer = taskDefinition.addContainer("AdotCollector", {
          containerName: "adot-collector",
          image: cdk.aws_ecs.ContainerImage.fromRegistry(
            "public.ecr.aws/aws-observability/aws-otel-collector:v0.46.0"
          ),
          essential: false,
          logging: cdk.aws_ecs.LogDrivers.awsLogs({
            streamPrefix: "adot-collector",
          }),
          environment: {
            AWS_REGION: cdk.Stack.of(this).region,
          },
          secrets: {
            AOT_CONFIG_CONTENT:
              cdk.aws_ecs.Secret.fromSsmParameter(otelConfigParameter),
          },
        });

        otelContainer.addContainerDependencies({
          container: logRouterContainer,
          condition: cdk.aws_ecs.ContainerDependencyCondition.START,
        });

        taskDefinition.taskRole.addToPrincipalPolicy(
          new cdk.aws_iam.PolicyStatement({
            effect: cdk.aws_iam.Effect.ALLOW,
            actions: [
              "logs:CreateLogGroup",
              "logs:CreateLogStream",
              "logs:PutLogEvents",
              "logs:PutRetentionPolicy",
              "logs:DescribeLogGroups",
              "logs:DescribeLogStreams",
            ],
            resources: [
              cdk.Arn.format(
                {
                  service: "logs",
                  resource: "log-group",
                  resourceName: `/aws/ecs/containerinsights/${cluster.clusterName}/prometheus:*`,
                  arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                },
                cdk.Stack.of(this)
              ),
            ],
          })
        );

        // resourcedetection processor用
        taskDefinition.taskRole.addToPrincipalPolicy(
          new cdk.aws_iam.PolicyStatement({
            effect: cdk.aws_iam.Effect.ALLOW,
            actions: ["ecs:DescribeTasks"],
            resources: ["*"],
          })
        );

        // Application Signals用権限
        if (props.enableApplicationSignals) {
          taskDefinition.taskRole.addToPrincipalPolicy(
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: [
                "xray:PutTraceSegments",
                "xray:PutTelemetryRecords",
                "xray:GetSamplingRules",
                "xray:GetSamplingTargets",
                "xray:GetSamplingStatisticSummaries",
              ],
              resources: ["*"],
            })
          );

          // Application Signals用CloudWatch Logs権限
          taskDefinition.taskRole.addToPrincipalPolicy(
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "logs:PutRetentionPolicy",
              ],
              resources: [
                cdk.Arn.format(
                  {
                    service: "logs",
                    resource: "log-group",
                    resourceName: "/aws/application-signals/data:*",
                    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                  },
                  cdk.Stack.of(this)
                ),
              ],
            })
          );

          // Application Signals API権限
          taskDefinition.taskRole.addToPrincipalPolicy(
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: [
                "application-signals:StartDiscovery",
                "application-signals:GetServiceLevelObjective",
              ],
              resources: ["*"],
            })
          );

          // CloudWatch Metrics権限
          taskDefinition.taskRole.addToPrincipalPolicy(
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: ["cloudwatch:PutMetricData"],
              resources: ["*"],
              conditions: {
                StringEquals: {
                  "cloudwatch:namespace": "ApplicationSignals",
                },
              },
            })
          );
        }

        otelConfigParameter.grantRead(taskDefinition.executionRole!);
      }
    }
    ecsExecLogBucketConstruct.bucket.grantPut(taskDefinition.taskRole);

    // ECS Service
    const service = new cdk.aws_ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition,
      desiredCount: 1,
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

    if (props.aurora) {
      props.aurora.cluster.connections.allowFrom(
        service,
        cdk.aws_ec2.Port.tcp(5432),
        "Allow ECS to Aurora PostgreSQL"
      );
    }

    if (props.valkey) {
      props.valkey.securityGroup.addIngressRule(
        service.connections.securityGroups[0],
        cdk.aws_ec2.Port.tcp(props.valkey.port),
        "Allow ECS to Valkey"
      );
    }

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
