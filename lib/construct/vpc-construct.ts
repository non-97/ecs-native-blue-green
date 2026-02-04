import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface VpcConstructProps {}

export class VpcConstruct extends Construct {
  readonly vpc: cdk.aws_ec2.IVpc;

  constructor(scope: Construct, id: string, props?: VpcConstructProps) {
    super(scope, id);

    const vpc = new cdk.aws_ec2.Vpc(this, "Default", {
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr("10.10.8.0/22"),
      enableDnsHostnames: true,
      enableDnsSupport: true,
      natGateways: 1,
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
          cidrMask: 27,
          mapPublicIpOnLaunch: false,
        },
        {
          name: "Egress",
          subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 27,
        },
        {
          name: "Isolated",
          subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 27,
        },
      ],
      gatewayEndpoints: {
        S3: {
          service: cdk.aws_ec2.GatewayVpcEndpointAwsService.S3,
        },
      },
    });

    this.vpc = vpc;
  }
}
