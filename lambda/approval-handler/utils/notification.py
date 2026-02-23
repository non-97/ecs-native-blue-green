"""
Slack通知メッセージ生成モジュール

Amazon Q Developer in chat applications (旧AWS Chatbot) の
Custom Notification スキーマに準拠したメッセージを生成する。

通知メッセージにはカスタムアクションボタンの変数(additionalContext)が含まれ、
ボタン押下時に `ssm put-parameter` コマンドの引数として展開される。

ref: https://docs.aws.amazon.com/chatbot/latest/adminguide/custom-notifs.html
"""

from __future__ import annotations

from typing import Any


def create_approval_message(
    parameter_name: str,
    region: str,
    account_id: str,
    cluster_name: str,
    service_name: str,
    revision_id: str,
    service_deployment_id: str,
    service_detail: dict[str, Any],
    callback_delay_seconds: int,
) -> dict[str, Any]:
    """Slack通知用メッセージを生成する(Chatbot Custom Notification スキーマ準拠)。

    list_service_deploymentsから取得したサービスデプロイメントIDでコンソールURLを組み立て、
    describe_servicesからベイクタイムを抽出して、通知メッセージを生成する。

    カスタムアクションボタンで使用する変数(metadata.additionalContext):
    - ActionGroup: ボタン表示条件のフィルタリングに使用
    - parameterName: SSMパラメータ名($parameterName として commandText に展開)
    - region: AWSリージョン($region として commandText に展開)
    """
    # describe_servicesレスポンスからベイクタイムを抽出
    bake_time_minutes: int = 0
    services: list[dict[str, Any]] = service_detail.get("services", [])
    if services:
        bake_time_minutes = (
            services[0].get("deploymentConfiguration", {}).get("bakeTimeInMinutes", 0)
        )

    # AWSコンソールのサービスデプロイメント詳細ページURL
    deployment_url: str = (
        f"https://{region}.console.aws.amazon.com/ecs/v2/clusters/{cluster_name}/"
        f"services/{service_name}/service-deployments/{service_deployment_id}?region={region}"
    )

    description: str = (
        f"@channel\n\n"
        f"- *Account* : `{account_id}`\n"
        f"- *Region* : `{region}`\n"
        f"- *ECS Cluster* : `{cluster_name}`\n"
        f"- *ECS Service* : `{service_name}`\n"
        f"- *Service Revision ID* : `{revision_id}`\n"
        f"- *Service Deployment ID* : `{service_deployment_id}`\n"
        f"- *Service Deployment URL* : {deployment_url}\n"
        f"- *Bake Time* : `{bake_time_minutes} 分`\n"
        f"- *Lifecycle Hook Polling Interval* : `{callback_delay_seconds} 秒`\n\n"
        f"---\n"
        f"テストトラフィックが新しいリビジョンのタスクに正常に再ルーティングされました。\n"
        f"動作確認の上、本番トラフィックも新しいリビジョンのタスクに *再ルーティングするか* 、それとも *ロールバックするか* を選択してください。\n"
        f"選択は *24時間以内* に行う必要があります。24時間以内に再ルーティングしない場合は *自動でロールバック* が開始されます。\n\n"
        f"---\n"
        f"動作補足 : \n\n"
        f"*Lifecycle Hook Polling Interval* の間隔でLambda関数がSSM Parameter Store (`/ecs/<cluster>/<service>/ecs-native-blue-green-approval/<revisionId>`) の値をポーリングします。\n"
        f"ボタンをクリックすることで、SSM Parameter Storeに *再ルーティング* / *ロールバック* に応じた値を書き込みます。\n"
        f"Lambda関数はSSM Parameter Storeに書き込まれた値に応じて *再ルーティング* / *ロールバック* の指示を行います。\n"
        f"---\n"
        f"ref : \n"
        f"- <https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/blue-green-deployment-how-it-works.html|Amazon ECS ブルー/グリーンサービスのデプロイワークフロー - Amazon Elastic Container Service>\n"
        f"- <https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/deployment-lifecycle-hooks.html|Amazon ECS サービスデプロイのライフサイクルフック - Amazon Elastic Container Service>"
    )

    message: dict[str, Any] = {
        "version": "1.0",
        "source": "custom",
        "content": {
            "textType": "client-markdown",
            "title": ":rocket: ECS Blue/Green Deployment - 本番トラフィックの再ルーティング承認依頼",
            "description": description,
        },
        "metadata": {
            "additionalContext": {
                "ActionGroup": "ecs-blue-green-deployment_POST_TEST_TRAFFIC_SHIFT",
                "parameterName": parameter_name,
                "region": region,
            },
            "enableCustomActions": True,
        },
    }

    return message
