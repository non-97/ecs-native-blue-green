import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface BucketConstructProps {
  bucketName?: string;
  accessControl?: cdk.aws_s3.BucketAccessControl;
  allowDeleteBucketAndObjects?: boolean;
  s3ServerAccessLogBucketConstruct?: BucketConstruct;
}

export class BucketConstruct extends Construct {
  readonly bucket: cdk.aws_s3.Bucket;

  constructor(scope: Construct, id: string, props?: BucketConstructProps) {
    super(scope, id);

    this.bucket = new cdk.aws_s3.Bucket(this, "Default", {
      bucketName: props?.bucketName,
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: new cdk.aws_s3.BlockPublicAccess({
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      }),
      enforceSSL: true,
      removalPolicy: props?.allowDeleteBucketAndObjects
        ? cdk.RemovalPolicy.DESTROY
        : undefined,
      autoDeleteObjects: props?.allowDeleteBucketAndObjects ? true : undefined,
      accessControl: props?.accessControl,
      serverAccessLogsBucket: props?.s3ServerAccessLogBucketConstruct?.bucket,
    });
  }
}
