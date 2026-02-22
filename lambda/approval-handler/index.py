from aws_lambda_powertools import Logger, Tracer
import boto3
import os
import json
from botocore.exceptions import ClientError
from utils.notification import create_approval_message

logger = Logger()
tracer = Tracer()

sns_client = boto3.client("sns")
ecs_client = boto3.client("ecs")
ssm_client = boto3.client("ssm")


@tracer.capture_lambda_handler
@logger.inject_lambda_context
def handler(event: dict, context) -> dict:
    """
    ECS Blue/Green Deployment POST_TEST_TRAFFIC_SHIFT Lifecycle Hook Handler

    SSM Parameterの値を確認して承認/拒否を判定する。
    初回呼び出し時にSlack通知を送信し、カスタムアクションボタンで
    SSMパラメータが作成（approved/rejected）されるのを待つ。

    パラメータ名: /ecs/<cluster>/<service>/ecs-native-blue-green-approval/<revisionId>

    イベント構造（ECS Native Blue/Green）:
    {
        "executionDetails": {
            "serviceArn": "arn:aws:ecs:region:account:service/cluster/service",
            "targetServiceRevisionArn": "arn:aws:ecs:region:account:service-revision/..."
        },
        "hookDetails": {
            "notificationSent": true  // 2回目以降の呼び出しで設定される
        }
    }

    レスポンス:
    {
        "hookStatus": "SUCCEEDED" | "FAILED" | "IN_PROGRESS",
        "callBackDelay": 30,
        "hookDetails": {}
    }
    """

    logger.info("Lifecycle Hook event received", extra={"event": event})

    # イベント構造に応じてフィールド取得
    hook_details = event.get("hookDetails") or {}
    execution_details = event.get("executionDetails") or {}

    service_arn = execution_details.get("serviceArn") or event.get("serviceArn")
    revision_arn = execution_details.get("targetServiceRevisionArn") or event.get(
        "targetServiceRevisionArn"
    )

    if not service_arn or not revision_arn:
        logger.error("Missing required fields in event")
        return hook_failed()

    # service ARNからクラスター名・サービス名を抽出
    arn_parts = service_arn.split(":")
    resource_parts = arn_parts[5].split("/")
    cluster_name = resource_parts[1]
    service_name = resource_parts[2]

    # revision_idを抽出
    revision_id = revision_arn.split("/")[-1]

    # SSMパラメータ名を構築
    parameter_name = f"/ecs/{cluster_name}/{service_name}/ecs-native-blue-green-approval/{revision_id}"

    logger.info(
        "Processing lifecycle hook",
        extra={
            "service_arn": service_arn,
            "revision_id": revision_id,
            "parameter_name": parameter_name,
        },
    )

    # 初回呼び出し判定
    is_first_invocation = not hook_details.get("notificationSent", False)

    if is_first_invocation:
        # 初回: SNS経由でSlack通知を送信（パラメータはカスタムアクションボタンで作成される）
        try:
            deployment_info = get_deployment_info(service_arn, revision_arn)
            message = create_approval_message(
                parameter_name=parameter_name,
                service_arn=service_arn,
                target_revision_arn=revision_arn,
                deployment_info=deployment_info,
            )

            sns_client.publish(
                TopicArn=os.environ["SNS_TOPIC_ARN"],
                Message=json.dumps(message),
                Subject="ECS Blue/Green Deployment - 本番トラフィックの再ルーティング",
            )

            logger.info("Slack notification sent")
        except Exception:
            logger.exception("Failed to send notification")
            return hook_failed()

        return hook_in_progress()

    # 2回目以降: SSMパラメータの値を確認
    approval_status = check_approval_status(parameter_name)

    if approval_status == "approved":
        logger.info("Deployment approved via SSM parameter")
        delete_parameter(parameter_name)
        return hook_succeeded()

    if approval_status == "rejected":
        logger.info("Deployment rejected via SSM parameter")
        delete_parameter(parameter_name)
        return hook_failed()

    # まだ決定されていない → 再ポーリング
    logger.info("No approval/rejection found, continuing to poll")
    return hook_in_progress()


def hook_succeeded() -> dict:
    return {"hookStatus": "SUCCEEDED"}


def hook_failed() -> dict:
    return {"hookStatus": "FAILED"}


def hook_in_progress() -> dict:
    return {
        "hookStatus": "IN_PROGRESS",
        "callBackDelay": 30,
        "hookDetails": {"notificationSent": True},
    }


def check_approval_status(parameter_name: str) -> str | None:
    """SSMパラメータの値を確認（パラメータ未作成=未決定）"""
    try:
        response = ssm_client.get_parameter(Name=parameter_name)
        value = response["Parameter"]["Value"]
        if value in ("approved", "rejected"):
            return value
        return None
    except ClientError as e:
        if e.response["Error"]["Code"] == "ParameterNotFound":
            logger.info(
                "SSM parameter not yet created (awaiting user action)",
                extra={"parameter_name": parameter_name},
            )
            return None
        logger.exception(
            "Error checking SSM parameter",
            extra={"parameter_name": parameter_name},
        )
        return None


def delete_parameter(parameter_name: str) -> None:
    """SSMパラメータを削除（クリーンアップ）"""
    try:
        ssm_client.delete_parameter(Name=parameter_name)
        logger.info("Deleted SSM parameter", extra={"parameter_name": parameter_name})
    except ClientError:
        logger.exception(
            "Failed to delete SSM parameter",
            extra={"parameter_name": parameter_name},
        )


def get_deployment_info(service_arn: str, target_revision_arn: str) -> dict:
    """ECSサービスとデプロイ情報を取得"""
    try:
        arn_parts = service_arn.split(":")
        region = arn_parts[3]
        account_id = arn_parts[4]

        resource_parts = arn_parts[5].split("/")
        cluster_name = resource_parts[1]
        service_name = resource_parts[2]

        response = ecs_client.describe_services(
            cluster=cluster_name, services=[service_name]
        )

        if not response["services"]:
            logger.warning("Service not found")
            return create_minimal_deployment_info(
                region, account_id, cluster_name, service_name, target_revision_arn
            )

        service = response["services"][0]
        deployments = service.get("deployments", [])

        active_deployment = next(
            (d for d in deployments if d["status"] == "PRIMARY"), None
        )

        deployment_id = (
            active_deployment.get("id", "unknown") if active_deployment else "unknown"
        )

        revision_id = target_revision_arn.split("/")[-1]
        service_revision_url = generate_service_revision_url(
            region, cluster_name, service_name, revision_id
        )

        return {
            "accountId": account_id,
            "region": region,
            "clusterName": cluster_name,
            "serviceName": service_name,
            "deploymentId": deployment_id,
            "serviceRevisionUrl": service_revision_url,
            "targetRevisionArn": target_revision_arn,
        }
    except Exception:
        logger.exception("Failed to get deployment info")
        return extract_minimal_info_from_arn(service_arn, target_revision_arn)


def generate_service_revision_url(
    region: str, cluster_name: str, service_name: str, revision_id: str
) -> str:
    return (
        f"https://{region}.console.aws.amazon.com/ecs/v2/clusters/{cluster_name}/"
        f"services/{service_name}/service-revisions/{revision_id}/overview?region={region}"
    )


def create_minimal_deployment_info(
    region: str,
    account_id: str,
    cluster_name: str,
    service_name: str,
    target_revision_arn: str,
) -> dict:
    revision_id = target_revision_arn.split("/")[-1]
    return {
        "accountId": account_id,
        "region": region,
        "clusterName": cluster_name,
        "serviceName": service_name,
        "deploymentId": "unknown",
        "serviceRevisionUrl": generate_service_revision_url(
            region, cluster_name, service_name, revision_id
        ),
        "targetRevisionArn": target_revision_arn,
    }


def extract_minimal_info_from_arn(service_arn: str, target_revision_arn: str) -> dict:
    try:
        arn_parts = service_arn.split(":")
        region = arn_parts[3]
        account_id = arn_parts[4]
        resource_parts = arn_parts[5].split("/")
        cluster_name = resource_parts[1] if len(resource_parts) > 1 else "unknown"
        service_name = resource_parts[2] if len(resource_parts) > 2 else "unknown"

        return create_minimal_deployment_info(
            region, account_id, cluster_name, service_name, target_revision_arn
        )
    except Exception:
        logger.exception("Failed to extract minimal info from ARN")
        return {
            "accountId": "unknown",
            "region": "unknown",
            "clusterName": "unknown",
            "serviceName": "unknown",
            "deploymentId": "unknown",
            "serviceRevisionUrl": "#",
            "targetRevisionArn": target_revision_arn,
        }
