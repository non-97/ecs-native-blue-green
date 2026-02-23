"""
ECS Blue/Green Deployment POST_TEST_TRAFFIC_SHIFT Lifecycle Hook Handler

ECS Native Blue/Green Deploymentのライフサイクルフック(POST_TEST_TRAFFIC_SHIFT)から
呼び出されるLambda関数。テストトラフィックの切り替え完了後に実行され、
Slack経由で承認/拒否の判断をユーザーに求める。

フロー:
  1. 初回デプロイ(Blue環境なし)の場合は即SUCCEEDED
  2. フック初回呼び出し時にSNS経由でSlack通知を送信
  3. 2回目以降はSSM Parameterの値をポーリングして承認/拒否を判定
  4. 承認/拒否確定後にSSMパラメータを削除(クリーンアップ)

SSMパラメータはSlack上のカスタムアクションボタン(Amazon Q Developer in chat applications)から
`ssm put-parameter` コマンドで作成される。Lambda側ではパラメータを事前作成しない。

パラメータ名: /ecs/<cluster>/<service>/ecs-native-blue-green-approval/<revisionId>
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

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

# ライフサイクルフックのレスポンスで使用するステータス
HookStatus = Literal["SUCCEEDED", "FAILED", "IN_PROGRESS"]

# SSMパラメータの承認ステータス
ApprovalStatus = Literal["approved", "rejected"]

# ライフサイクルフックのポーリング間隔(秒)
# ECSがこの間隔でLambdaを再呼び出しして承認/拒否をチェックする
CALLBACK_DELAY_SECONDS: int = 30


@dataclass(frozen=True)
class HookContext:
    """ライフサイクルフックイベントから解析された情報を保持するデータクラス。"""

    region: str
    account_id: str
    cluster_name: str
    service_name: str
    revision_id: str
    revision_arn: str
    parameter_name: str
    is_first_invocation: bool


@tracer.capture_lambda_handler
@logger.inject_lambda_context
def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """
    POST_TEST_TRAFFIC_SHIFT Lifecycle Hook Handler

    ECSのライフサイクルフックから呼び出される。呼び出しパターンは以下の2種類:

    1. 初回呼び出し: hookDetailsが空 → Slack通知を送信しIN_PROGRESSを返す
    2. コールバック: hookDetails.notificationSent=True → SSMパラメータをポーリング

    イベント構造(ECS Native Blue/Green):
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
        "callBackDelay": 30,       // IN_PROGRESS時のみ: 次回呼び出しまでの待機秒数
        "hookDetails": {}          // IN_PROGRESS時のみ: 次回呼び出し時に渡される状態
    }
    """
    logger.info("Lifecycle Hook event received", extra={"event": event})

    # 1. イベント解析・バリデーション
    ctx: HookContext | None = parse_event(event)
    if ctx is None:
        return hook_failed()

    # 2. サービス情報取得
    service_detail: dict[str, Any] = describe_service(
        ctx.cluster_name, ctx.service_name
    )

    # 3. 初回デプロイ判定(Blue環境なし → 承認不要)
    if is_initial_deployment(service_detail):
        return hook_succeeded()

    # 4. フック初回呼び出し → Slack通知送信
    if ctx.is_first_invocation:
        return send_approval_notification(ctx, service_detail)

    # 5. 2回目以降 → 承認/拒否ポーリング
    return poll_approval(ctx.parameter_name)


# --- イベント解析 ---


def parse_event(event: dict[str, Any]) -> HookContext | None:
    """ライフサイクルフックイベントを解析してHookContextを返す。

    イベントから serviceArn, targetServiceRevisionArn を取得し、
    ARNをパースしてリージョン/アカウントID/クラスター名/サービス名/リビジョンIDを抽出する。
    必須フィールドが不足している場合は None を返す。
    """
    hook_details: dict[str, Any] = event.get("hookDetails") or {}
    execution_details: dict[str, Any] = event.get("executionDetails") or {}

    service_arn: str | None = execution_details.get("serviceArn") or event.get(
        "serviceArn"
    )
    revision_arn: str | None = execution_details.get(
        "targetServiceRevisionArn"
    ) or event.get("targetServiceRevisionArn")

    if not service_arn or not revision_arn:
        logger.error("Missing required fields in event")
        return None

    # service ARNからリージョン/アカウントID/クラスター名/サービス名を抽出
    # ARN形式: arn:aws:ecs:<region>:<account>:service/<cluster>/<service>
    arn_parts: list[str] = service_arn.split(":")
    region: str = arn_parts[3]
    account_id: str = arn_parts[4]
    resource_parts: list[str] = arn_parts[5].split("/")
    cluster_name: str = resource_parts[1]
    service_name: str = resource_parts[2]

    # revision_idを抽出
    # ARN形式: arn:aws:ecs:<region>:<account>:service-revision/<cluster>/<service>/<revision-id>
    revision_id: str = revision_arn.split("/")[-1]

    # SSMパラメータ名を構築
    parameter_name: str = (
        f"/ecs/{cluster_name}/{service_name}/ecs-native-blue-green-approval/{revision_id}"
    )

    ctx = HookContext(
        region=region,
        account_id=account_id,
        cluster_name=cluster_name,
        service_name=service_name,
        revision_id=revision_id,
        revision_arn=revision_arn,
        parameter_name=parameter_name,
        is_first_invocation=not hook_details.get("notificationSent", False),
    )

    logger.info(
        "Processing lifecycle hook",
        extra={
            "service_arn": service_arn,
            "revision_id": ctx.revision_id,
            "parameter_name": ctx.parameter_name,
        },
    )

    return ctx


# --- サービス情報取得・判定 ---


def describe_service(cluster_name: str, service_name: str) -> dict[str, Any]:
    """ECSサービスの情報を取得する。

    初回デプロイ判定と通知用デプロイ情報の構築の両方で使用する。
    API呼び出し失敗時は空のレスポンスを返す(安全側フォールバック)。
    """
    try:
        return ecs_client.describe_services(
            cluster=cluster_name, services=[service_name]
        )
    except Exception:
        logger.exception("Failed to describe services")
        return {"services": []}


def get_service_deployment_id(
    cluster_name: str, service_name: str, revision_arn: str
) -> str:
    """list_service_deploymentsからサービスデプロイメントIDを取得する。

    IN_PROGRESSステータスのデプロイメントからtargetServiceRevisionArnが一致するものを検索し、
    serviceDeploymentArnの末尾をデプロイメントIDとして返す。
    取得できない場合は "unknown" を返す。
    """
    try:
        response = ecs_client.list_service_deployments(
            cluster=cluster_name,
            service=service_name,
            status=["IN_PROGRESS"],
        )
        for deployment in response.get("serviceDeployments", []):
            if deployment.get("targetServiceRevisionArn") == revision_arn:
                # ARN形式: arn:aws:ecs:<region>:<account>:service-deployment/<cluster>/<service>/<id>
                return deployment["serviceDeploymentArn"].split("/")[-1]
    except Exception:
        logger.exception("Failed to list service deployments")
    return "unknown"


def is_initial_deployment(service_detail: dict[str, Any]) -> bool:
    """サービスの初回デプロイかどうかを判定する。

    deploymentsが1つ以下 = Blue環境(旧リビジョン)が存在しない = 初回デプロイ。
    初回デプロイでは再ルーティング/ロールバックの選択が不要。
    """
    services: list[dict[str, Any]] = service_detail.get("services", [])
    if not services:
        return False
    deployments: list[dict[str, Any]] = services[0].get("deployments", [])
    if len(deployments) <= 1:
        logger.info("Initial deployment detected, skipping approval")
        return True
    return False


# --- フック初回呼び出し: Slack通知送信 ---


def send_approval_notification(
    ctx: HookContext, service_detail: dict[str, Any]
) -> dict[str, Any]:
    """SNS経由でSlack承認通知を送信し、IN_PROGRESSを返す。

    通知送信に失敗した場合はFAILEDを返す(デプロイをロールバック)。
    SSMパラメータはカスタムアクションボタンのCLIコマンドで作成されるため、
    Lambda側では事前作成しない。
    """
    try:
        service_deployment_id: str = get_service_deployment_id(
            ctx.cluster_name, ctx.service_name, ctx.revision_arn
        )

        message: dict[str, Any] = create_approval_message(
            parameter_name=ctx.parameter_name,
            region=ctx.region,
            account_id=ctx.account_id,
            cluster_name=ctx.cluster_name,
            service_name=ctx.service_name,
            revision_id=ctx.revision_id,
            service_deployment_id=service_deployment_id,
            service_detail=service_detail,
            callback_delay_seconds=CALLBACK_DELAY_SECONDS,
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


# --- 2回目以降: 承認/拒否ポーリング ---


def poll_approval(parameter_name: str) -> dict[str, Any]:
    """SSMパラメータをポーリングして承認/拒否を判定する。

    approved → パラメータ削除 + SUCCEEDED(本番トラフィック再ルーティング)
    rejected → パラメータ削除 + FAILED(ロールバック)
    未決定  → IN_PROGRESS(次回コールバックで再ポーリング)
    """
    approval_status: ApprovalStatus | None = check_approval_status(parameter_name)

    if approval_status == "approved":
        logger.info("Deployment approved via SSM parameter")
        delete_parameter(parameter_name)
        return hook_succeeded()

    if approval_status == "rejected":
        logger.info("Deployment rejected via SSM parameter")
        delete_parameter(parameter_name)
        return hook_failed()

    logger.info("No approval/rejection found, continuing to poll")
    return hook_in_progress()


def check_approval_status(parameter_name: str) -> ApprovalStatus | None:
    """SSMパラメータの値を確認して承認ステータスを返す。

    カスタムアクションボタンから `ssm put-parameter` で作成されたパラメータの値を確認する。
    パラメータが未作成(ParameterNotFound)の場合はユーザーがまだボタンを押していない状態。

    Returns:
        "approved": 承認済み → デプロイ続行
        "rejected": 拒否済み → ロールバック
        None: 未決定(パラメータ未作成 or 不明な値)
    """
    try:
        response = ssm_client.get_parameter(Name=parameter_name)
        value: str = response["Parameter"]["Value"]
        if value in ("approved", "rejected"):
            return value  # type: ignore[return-value]
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
    """SSMパラメータを削除する(承認/拒否確定後のクリーンアップ)。

    パラメータはデプロイメントごとに作成されるため、
    承認/拒否が確定したら不要になる。削除に失敗してもデプロイには影響しない。
    """
    try:
        ssm_client.delete_parameter(Name=parameter_name)
        logger.info("Deleted SSM parameter", extra={"parameter_name": parameter_name})
    except ClientError:
        logger.exception(
            "Failed to delete SSM parameter",
            extra={"parameter_name": parameter_name},
        )


# --- Hook Response Helpers ---


def hook_succeeded() -> dict[str, Any]:
    """ライフサイクルフックを正常完了させるレスポンスを返す。
    本番トラフィックの再ルーティングが進行する。"""
    return {"hookStatus": "SUCCEEDED"}


def hook_failed() -> dict[str, Any]:
    """ライフサイクルフックを失敗させるレスポンスを返す。
    デプロイメントがロールバックされる。"""
    return {"hookStatus": "FAILED"}


def hook_in_progress() -> dict[str, Any]:
    """ライフサイクルフックを継続中にするレスポンスを返す。
    callBackDelay秒後にECSが再度このLambdaを呼び出す。
    hookDetailsは次回呼び出し時にイベントに含まれる。"""
    return {
        "hookStatus": "IN_PROGRESS",
        "callBackDelay": CALLBACK_DELAY_SECONDS,
        "hookDetails": {"notificationSent": True},
    }
