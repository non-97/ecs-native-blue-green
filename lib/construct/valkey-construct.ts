import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface ValkeyConstructProps {
  /** VPC */
  vpc: cdk.aws_ec2.IVpc;
  /** キャッシュ名 */
  cacheName?: string;
}

export class ValkeyConstruct extends Construct {
  /** 接続エンドポイント */
  readonly endpoint: string;
  /** 接続ポート */
  readonly port: number;
  /** セキュリティグループ */
  readonly securityGroup: cdk.aws_ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: ValkeyConstructProps) {
    super(scope, id);

    const cacheName =
      props.cacheName ??
      `${cdk.Names.uniqueId(this).toLowerCase().slice(0, 30)}-valkey`;

    // セキュリティグループ
    const securityGroup = new cdk.aws_ec2.SecurityGroup(
      this,
      "SecurityGroup",
      {
        vpc: props.vpc,
        description: "Security group for ElastiCache Valkey Serverless",
        allowAllOutbound: false,
      }
    );
    this.securityGroup = securityGroup;

    // Valkey Serverless キャッシュ（L1構文）
    const cache = new cdk.aws_elasticache.CfnServerlessCache(
      this,
      "ServerlessCache",
      {
        engine: "valkey",
        serverlessCacheName: cacheName,
        majorEngineVersion: "8",
        securityGroupIds: [securityGroup.securityGroupId],
        subnetIds: props.vpc.selectSubnets({
          subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
        }).subnetIds,
        cacheUsageLimits: {
          dataStorage: {
            maximum: 1, // 最小値: 1 GB
            unit: "GB",
          },
          ecpuPerSecond: {
            maximum: 1000, // 最小値: 1000 ECPU/秒
          },
        },
      }
    );

    // エンドポイント取得
    this.endpoint = cache.attrEndpointAddress;
    this.port = 6379;
  }
}
