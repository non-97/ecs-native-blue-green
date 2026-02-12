import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { BucketConstruct } from "./bucket-construct";
import * as path from "path";
import * as fs from "fs";

// コンテナイメージ
const CONTAINER_IMAGES = {
  FLUENT_BIT: "public.ecr.aws/aws-observability/aws-for-fluent-bit:init-3.2.0",
  ADOT_COLLECTOR: "public.ecr.aws/aws-observability/aws-otel-collector:v0.47.0",
  ADOT_NODE_AUTOINSTRUMENTATION:
    "public.ecr.aws/aws-observability/adot-autoinstrumentation-node:v0.8.1",
} as const;

// OTEL設定ファイルパス
const OTEL_CONFIG_PATHS = {
  DEFAULT: "../../src/otel-config/otel-config.yaml",
  APP_SIGNALS: "../../src/otel-config/otel-app-signals.yaml",
} as const;

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
  private readonly props: EcsConstructProps;
  private readonly cluster: cdk.aws_ecs.Cluster;
  private readonly taskDefinition: cdk.aws_ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: EcsConstructProps) {
    super(scope, id);
    this.props = props;

    // ECS Exec log destinations
    const ecsExecLogBucketConstruct = new BucketConstruct(
      this,
      "ecsExecLogBucketConstruct"
    );

    this.cluster = this.createCluster(ecsExecLogBucketConstruct.bucket);
    this.taskDefinition = this.createTaskDefinition();

    // コンテナの追加
    this.addAdotAutoInstrumentationInitContainer();
    const webContainer = this.addWebContainer();
    const appContainer = this.addAppContainer();

    this.setupContainerDependencies(webContainer, appContainer);
    this.setupFireLens();

    ecsExecLogBucketConstruct.bucket.grantPut(this.taskDefinition.taskRole);

    // ECS Service
    const service = this.createService();
    this.setupConnections(service);
    this.setupLoadBalancerTarget(service, webContainer);
  }

  private createCluster(
    execLogBucket: cdk.aws_s3.IBucket
  ): cdk.aws_ecs.Cluster {
    return new cdk.aws_ecs.Cluster(this, "Cluster", {
      vpc: this.props.vpc,
      containerInsightsV2: cdk.aws_ecs.ContainerInsights.ENHANCED,
      executeCommandConfiguration: {
        logConfiguration: {
          s3Bucket: execLogBucket,
          s3EncryptionEnabled: true,
        },
        logging: cdk.aws_ecs.ExecuteCommandLogging.OVERRIDE,
      },
    });
  }

  private createTaskDefinition(): cdk.aws_ecs.FargateTaskDefinition {
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

    if (this.props.enableApplicationSignals) {
      taskDefinition.addVolume({
        name: "opentelemetry-auto-instrumentation",
      });
    }

    return taskDefinition;
  }

  private addAdotAutoInstrumentationInitContainer(): void {
    if (!this.props.enableApplicationSignals) {
      return;
    }

    const initContainer = this.taskDefinition.addContainer(
      "AdotAutoInstrumentationInitContainer",
      {
        containerName: "init",
        image: cdk.aws_ecs.ContainerImage.fromRegistry(
          CONTAINER_IMAGES.ADOT_NODE_AUTOINSTRUMENTATION
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
      }
    );

    initContainer.addMountPoints({
      sourceVolume: "opentelemetry-auto-instrumentation",
      containerPath: "/otel-auto-instrumentation",
      readOnly: false,
    });
  }

  private addWebContainer(): cdk.aws_ecs.ContainerDefinition {
    return this.taskDefinition.addContainer("WebContainer", {
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
      logging: this.props.firelens
        ? cdk.aws_ecs.LogDrivers.firelens({})
        : cdk.aws_ecs.LogDrivers.awsLogs({
            streamPrefix: "web",
          }),
    });
  }

  private buildAppEnvironment(): Record<string, string> {
    const appEnvironment: Record<string, string> = {};

    if (this.props.valkey) {
      appEnvironment["VALKEY_HOST"] = this.props.valkey.endpoint;
      appEnvironment["VALKEY_PORT"] = this.props.valkey.port.toString();
      appEnvironment["VALKEY_TLS"] = "true";
    }

    if (this.props.enableApplicationSignals) {
      // NODE_OPTIONS: Node.jsアプリケーション起動時にADOT自動計装エージェントを読み込む
      // initコンテナからコピーされた自動計装スクリプトを--requireで事前読み込みし、自動計装をさせる
      // ref: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Application-Signals-ECS-Sidecar.html
      appEnvironment["NODE_OPTIONS"] =
        "--require /otel-auto-instrumentation/autoinstrumentation.js";

      // OTEL_RESOURCE_ATTRIBUTES: トレースに付与するリソース属性
      // - service.name: Application Signalsダッシュボードに表示されるサービス名
      // - deployment.environment: 環境名。分かりやすいように "ecs:<クラスター名>" 形式を設定
      // - aws.log.group.names: ログ相関用
      // ref: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Application-Signals-ECS-Sidecar.html
      // ref: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AppSignals-MetricsCollected.html
      // ref: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Application-Signals-MetricLogCorrelation.html
      const resourceAttributes = [
        "service.name=ecs-express-app",
        `deployment.environment=ecs:${this.cluster.clusterName}`,
      ];
      if (this.props.firelens) {
        resourceAttributes.push(
          `aws.log.group.names=${this.props.firelens.logGroup.logGroupName}`
        );
      }
      appEnvironment["OTEL_RESOURCE_ATTRIBUTES"] = resourceAttributes.join(",");

      // OTEL_EXPORTER_OTLP_PROTOCOL: OTLPエクスポーターのプロトコル
      // http/protobuf（ポート4318）またはgrpc（ポート4317）を選択可能。ADOT Collectorは両方サポート
      // ref: https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/
      appEnvironment["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf";

      // OTEL_EXPORTER_OTLP_ENDPOINT: OTLPエクスポーターの送信先エンドポイント
      // 同一タスク内のADOT Collectorサイドカーに送信（localhost:4318はHTTP/protobuf用）
      // ref: https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/
      appEnvironment["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://localhost:4318";

      // OTEL_TRACES_EXPORTER: トレースのエクスポーター指定
      // "otlp"でOTLPプロトコルを使用してADOT Collectorに送信
      // ref: https://opentelemetry.io/docs/languages/sdk-configuration/general/#otel_traces_exporter
      appEnvironment["OTEL_TRACES_EXPORTER"] = "otlp";

      // OTEL_METRICS_EXPORTER: メトリクスのエクスポーター指定
      // "none"でSDKからのメトリクス送信を無効化。ADOT SDKで計算されるApplication Signalsのメトリクスの出力先は OTEL_AWS_APPLICATION_SIGNALS_EXPORTER_ENDPOINT で指定する
      // ref: https://opentelemetry.io/docs/languages/sdk-configuration/general/#otel_metrics_exporter
      appEnvironment["OTEL_METRICS_EXPORTER"] = "none";

      // OTEL_LOGS_EXPORTER: ログのエクスポーター指定
      // "none"でOTel経由のログ送信を無効化。ログはFireLens経由で別途収集
      // ref: https://opentelemetry.io/docs/languages/sdk-configuration/general/#otel_logs_exporter
      appEnvironment["OTEL_LOGS_EXPORTER"] = "none";

      // OTEL_TRACES_SAMPLER: トレースのサンプリング方式
      // "xray"でX-Rayの集中サンプリングを使用。サンプリングルールをAWSコンソールから一元管理可能
      // ref: https://opentelemetry.io/docs/languages/sdk-configuration/general/#otel_traces_sampler
      // ref: https://docs.aws.amazon.com/xray/latest/devguide/xray-console-sampling.html
      appEnvironment["OTEL_TRACES_SAMPLER"] = "xray";

      // OTEL_TRACES_SAMPLER_ARG: X-Rayサンプラーの設定
      // - endpoint: ADOT Collectorのawsproxy拡張機能エンドポイント（ポート2000）
      // - polling_interval: サンプリングルールのポーリング間隔（秒）
      // ref: https://aws-otel.github.io/docs/getting-started/remote-sampling
      // ref: https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/extension/awsproxy
      // ref : トレースのサンプリングレート - Amazon CloudWatch https://docs.aws.amazon.com/ja_jp/AmazonCloudWatch/latest/monitoring/Application-Signals-SampleRate.html
      // ref : Tracing and Metrics with the AWS Distro for OpenTelemetry JavaScript Auto-Instrumentation | AWS Distro for OpenTelemetry https://aws-otel.github.io/docs/getting-started/js-sdk/trace-metric-auto-instr#using-x-ray-remote-sampling
      appEnvironment["OTEL_TRACES_SAMPLER_ARG"] =
        "endpoint=http://localhost:2000,polling_interval=300";

      // OTEL_PROPAGATORS: コンテキスト伝播形式
      // - tracecontext: W3C Trace Context
      // - baggage: W3C Baggage
      // - xray: AWS X-Ray形式
      // ref: https://opentelemetry.io/docs/languages/sdk-configuration/general/#otel_propagators
      appEnvironment["OTEL_PROPAGATORS"] = "tracecontext,baggage,xray";

      // OTEL_AWS_APPLICATION_SIGNALS_ENABLED: クライアントサイドメトリクス生成
      // 現状、"true"にする場合はCloudWatch Agentサイドカー（ポート4316）が必要
      // Otel Collector 側で awsapplicationsignalsprocessor を使用することでも対応はできるが、ADOT Collectorには含まれていない
      // falseにし、サーバーサイドでトレースからLatency/Error/Faultメトリクスを生成させる
      // トレースからメトリクスを生成するため、記録されるメトリクスはサンプリングされたトレースのトラフィックのみ = 全てをサンプリングする場合を除いて、全てのトラフィックについてのメトリクスではないため、抜け漏れが発生する
      // ref: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Application-Signals-ECS-Sidecar.html
      // ref : https://github.com/amazon-contributing/opentelemetry-collector-contrib/tree/processor/awsapplicationsignalsprocessor/v0.121.0/processor/awsapplicationsignalsprocessor
      appEnvironment["OTEL_AWS_APPLICATION_SIGNALS_ENABLED"] = "false";
    }

    return appEnvironment;
  }

  private buildAppSecrets(): Record<string, cdk.aws_ecs.Secret> {
    const appSecrets: Record<string, cdk.aws_ecs.Secret> = {};

    if (this.props.aurora) {
      appSecrets["DB_HOST"] = cdk.aws_ecs.Secret.fromSecretsManager(
        this.props.aurora.secret,
        "host"
      );
      appSecrets["DB_PORT"] = cdk.aws_ecs.Secret.fromSecretsManager(
        this.props.aurora.secret,
        "port"
      );
      appSecrets["DB_USERNAME"] = cdk.aws_ecs.Secret.fromSecretsManager(
        this.props.aurora.secret,
        "username"
      );
      appSecrets["DB_PASSWORD"] = cdk.aws_ecs.Secret.fromSecretsManager(
        this.props.aurora.secret,
        "password"
      );
      appSecrets["DB_NAME"] = cdk.aws_ecs.Secret.fromSecretsManager(
        this.props.aurora.secret,
        "dbname"
      );
    }

    return appSecrets;
  }

  private addAppContainer(): cdk.aws_ecs.ContainerDefinition {
    const appContainer = this.taskDefinition.addContainer("AppContainer", {
      containerName: "app",
      image: cdk.aws_ecs.ContainerImage.fromAsset(
        path.join(__dirname, "../../src/container/app"),
        {
          platform: cdk.aws_ecr_assets.Platform.LINUX_ARM64,
        }
      ),
      essential: true,
      environment: this.buildAppEnvironment(),
      secrets: this.buildAppSecrets(),
      healthCheck: {
        command: [
          "CMD-SHELL",
          "wget -q -O - http://localhost:3000/health || exit 1",
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
      logging: this.props.firelens
        ? cdk.aws_ecs.LogDrivers.firelens({})
        : cdk.aws_ecs.LogDrivers.awsLogs({
            streamPrefix: "app",
          }),
    });

    if (this.props.enableApplicationSignals) {
      appContainer.addMountPoints({
        sourceVolume: "opentelemetry-auto-instrumentation",
        containerPath: "/otel-auto-instrumentation",
        readOnly: true,
      });

      const initContainer = this.taskDefinition.findContainer("init");
      if (initContainer) {
        appContainer.addContainerDependencies({
          container: initContainer,
          condition: cdk.aws_ecs.ContainerDependencyCondition.SUCCESS,
        });
      }
    }

    return appContainer;
  }

  private setupContainerDependencies(
    webContainer: cdk.aws_ecs.ContainerDefinition,
    appContainer: cdk.aws_ecs.ContainerDefinition
  ): void {
    webContainer.addContainerDependencies({
      container: appContainer,
      condition: cdk.aws_ecs.ContainerDependencyCondition.HEALTHY,
    });
  }

  private setupFireLens(): void {
    if (!this.props.firelens) {
      return;
    }

    const logRouterContainer = this.taskDefinition.addFirelensLogRouter(
      "logRouter",
      {
        image: cdk.aws_ecs.ContainerImage.fromRegistry(
          CONTAINER_IMAGES.FLUENT_BIT
        ),
        essential: true,
        logging: cdk.aws_ecs.LogDrivers.awsLogs({
          streamPrefix: `firelens/${this.taskDefinition.family}`,
        }),
        firelensConfig: {
          type: cdk.aws_ecs.FirelensLogRouterType.FLUENTBIT,
        },
        environment: {
          LOG_GROUP_NAME: this.props.firelens.logGroup.logGroupName,
          FIREHOSE_DELIVERY_STREAM_NAME:
            this.props.firelens.deliveryStream.deliveryStreamName,
          aws_fluent_bit_init_s3_1: `${this.props.firelens.confBucket.bucketArn}/extra.conf`,
          aws_fluent_bit_init_s3_2: `${this.props.firelens.confBucket.bucketArn}/parsers_custom.conf`,
        },
      }
    );

    this.props.firelens.confBucket.grantRead(this.taskDefinition.taskRole);
    this.props.firelens.deliveryStream.grantPutRecords(
      this.taskDefinition.taskRole
    );
    this.props.firelens.logGroup.grantWrite(this.taskDefinition.taskRole);

    if (
      this.props.enableFluentBitMetrics ||
      this.props.enableApplicationSignals
    ) {
      this.setupAdotCollector(logRouterContainer);
    }
  }

  private setupAdotCollector(
    logRouterContainer: cdk.aws_ecs.FirelensLogRouter
  ): void {
    const otelConfigPath = this.props.enableApplicationSignals
      ? OTEL_CONFIG_PATHS.APP_SIGNALS
      : OTEL_CONFIG_PATHS.DEFAULT;
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

    const otelContainer = this.taskDefinition.addContainer("AdotCollector", {
      containerName: "adot-collector",
      image: cdk.aws_ecs.ContainerImage.fromRegistry(
        CONTAINER_IMAGES.ADOT_COLLECTOR
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

    this.grantAdotPermissions();
    otelConfigParameter.grantRead(this.taskDefinition.executionRole!);
  }

  private grantAdotPermissions(): void {
    // Prometheus metrics用CloudWatch Logs権限
    this.taskDefinition.taskRole.addToPrincipalPolicy(
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
              resourceName: `/aws/ecs/containerinsights/${this.cluster.clusterName}/prometheus:*`,
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            },
            cdk.Stack.of(this)
          ),
        ],
      })
    );

    // resourcedetection processor用
    this.taskDefinition.taskRole.addToPrincipalPolicy(
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ["ecs:DescribeTasks"],
        resources: ["*"],
      })
    );

    if (this.props.enableApplicationSignals) {
      this.grantApplicationSignalsPermissions();
    }
  }

  private grantApplicationSignalsPermissions(): void {
    this.taskDefinition.taskRole.addManagedPolicy(
      cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AWSXrayWriteOnlyAccess"
      )
    );
  }

  private createService(): cdk.aws_ecs.FargateService {
    return new cdk.aws_ecs.FargateService(this, "Service", {
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      deploymentStrategy: cdk.aws_ecs.DeploymentStrategy.BLUE_GREEN,
      bakeTime: cdk.Duration.minutes(1),
      vpcSubnets: this.props.vpc.selectSubnets({
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }),
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: cdk.Duration.seconds(10),
      enableExecuteCommand: true,
    });
  }

  private setupConnections(service: cdk.aws_ecs.FargateService): void {
    service.connections.allowFrom(this.props.alb, cdk.aws_ec2.Port.tcp(80));

    if (this.props.aurora) {
      this.props.aurora.cluster.connections.allowFrom(
        service,
        cdk.aws_ec2.Port.tcp(5432),
        "Allow ECS to Aurora PostgreSQL"
      );
    }

    if (this.props.valkey) {
      this.props.valkey.securityGroup.addIngressRule(
        service.connections.securityGroups[0],
        cdk.aws_ec2.Port.tcp(this.props.valkey.port),
        "Allow ECS to Valkey"
      );
    }
  }

  private setupLoadBalancerTarget(
    service: cdk.aws_ecs.FargateService,
    webContainer: cdk.aws_ecs.ContainerDefinition
  ): void {
    const target = service.loadBalancerTarget({
      containerName: webContainer.containerName,
      containerPort: 80,
      protocol: cdk.aws_ecs.Protocol.TCP,
      alternateTarget: new cdk.aws_ecs.AlternateTarget("AlternateTarget", {
        alternateTargetGroup: this.props.tg2,
        productionListener:
          cdk.aws_ecs.ListenerRuleConfiguration.applicationListenerRule(
            this.props.listenerRule
          ),
        testListener:
          cdk.aws_ecs.ListenerRuleConfiguration.applicationListenerRule(
            this.props.testListenerRule
          ),
      }),
    });
    target.attachToApplicationTargetGroup(this.props.tg1);
  }
}
