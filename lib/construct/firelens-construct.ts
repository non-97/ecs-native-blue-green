import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { BucketConstruct } from "./bucket-construct";
import * as path from "path";

export interface FirelensConstructProps {}

export class FirelensConstruct extends Construct {
  readonly deliveryStream: cdk.aws_kinesisfirehose.IDeliveryStream;
  readonly firelensLogGroup: cdk.aws_logs.ILogGroup;
  readonly firelensConfBucket: cdk.aws_s3.IBucket;

  constructor(scope: Construct, id: string, props?: FirelensConstructProps) {
    super(scope, id);

    // Bucket
    const firelensConfBucketConstruct = new BucketConstruct(
      this,
      "FireLensConfBucket",
      {
        allowDeleteBucketAndObjects: true,
      }
    );
    this.firelensConfBucket = firelensConfBucketConstruct.bucket;

    const firelensLogBucketConstruct = new BucketConstruct(
      this,
      "FireLensLongBucket",
      {
        allowDeleteBucketAndObjects: true,
      }
    );

    new cdk.aws_s3_deployment.BucketDeployment(this, "FireLensConfDeployment", {
      destinationBucket: firelensConfBucketConstruct.bucket,
      sources: [
        cdk.aws_s3_deployment.Source.asset(
          path.join(__dirname, "../../src/fluentbit-config/")
        ),
      ],
      retainOnDelete: false,
    });

    // Log Group
    const firelensLogGroup = new cdk.aws_logs.LogGroup(
      this,
      "FirelensLogGroup"
    );
    this.firelensLogGroup = firelensLogGroup;

    // Firehose
    const deliveryStream = new cdk.aws_kinesisfirehose.DeliveryStream(
      this,
      "DeliveryStream",
      {
        destination: new cdk.aws_kinesisfirehose.S3Bucket(
          firelensLogBucketConstruct.bucket,
          {
            dataOutputPrefix:
              "ecs/!{partitionKeyFromQuery:ecs_cluster}/!{partitionKeyFromQuery:container_name}/!{partitionKeyFromQuery:source}/!{timestamp:yyyy/MM/dd/HH/}",
            errorOutputPrefix:
              "error/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd/HH/}",

            bufferingSize: cdk.Size.mebibytes(128),
            bufferingInterval: cdk.Duration.seconds(300),
            compression: cdk.aws_kinesisfirehose.Compression.GZIP,
            loggingConfig: new cdk.aws_kinesisfirehose.EnableLogging(),
          }
        ),
      }
    );
    const cfnDeliveryStream = deliveryStream.node
      .defaultChild as cdk.aws_kinesisfirehose.CfnDeliveryStream;
    cfnDeliveryStream.addPropertyOverride(
      "ExtendedS3DestinationConfiguration.DynamicPartitioningConfiguration",
      {
        Enabled: true,
      }
    );
    cfnDeliveryStream.addPropertyOverride(
      "ExtendedS3DestinationConfiguration.ProcessingConfiguration",
      {
        Enabled: true,
        Processors: [
          {
            Type: "MetadataExtraction",
            Parameters: [
              {
                ParameterName: "MetadataExtractionQuery",
                ParameterValue:
                  "{ecs_cluster: .ecs_cluster, container_name: .container_name, source : .source}",
              },
              {
                ParameterName: "JsonParsingEngine",
                ParameterValue: "JQ-1.6",
              },
            ],
          },
        ],
      }
    );
    this.deliveryStream = deliveryStream;
  }
}
