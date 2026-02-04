import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface AuroraConstructProps {
  /** VPC */
  vpc: cdk.aws_ec2.IVpc;
  /** データベース名 */
  databaseName?: string;
  /** Serverless v2 最小容量 (ACU) */
  minCapacity?: number;
  /** Serverless v2 最大容量 (ACU) */
  maxCapacity?: number;
}

export class AuroraConstruct extends Construct {
  /** Aurora クラスター */
  readonly cluster: cdk.aws_rds.DatabaseCluster;
  /** データベース認証情報のシークレット */
  readonly secret: cdk.aws_secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: AuroraConstructProps) {
    super(scope, id);

    const databaseName = props.databaseName ?? "appdb";
    const minCapacity = props.minCapacity ?? 0;
    const maxCapacity = props.maxCapacity ?? 1;

    // Aurora PostgreSQL Serverless v2 クラスター
    const cluster = new cdk.aws_rds.DatabaseCluster(this, "Cluster", {
      engine: cdk.aws_rds.DatabaseClusterEngine.auroraPostgres({
        version: cdk.aws_rds.AuroraPostgresEngineVersion.VER_16_8,
      }),
      credentials: cdk.aws_rds.Credentials.fromGeneratedSecret("clusteradmin", {
        secretName: `/${cdk.Names.uniqueId(this)}/rds/credentials`,
      }),
      // Single-AZ: writerのみ（readersなし）
      writer: cdk.aws_rds.ClusterInstance.serverlessV2("writer", {
        publiclyAccessible: false,
      }),
      serverlessV2MinCapacity: minCapacity,
      serverlessV2MaxCapacity: maxCapacity,
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
      },
      defaultDatabaseName: databaseName,
      storageEncrypted: true,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.cluster = cluster;
    this.secret = cluster.secret!;
  }
}
