def create_approval_message(
    parameter_name: str,
    service_arn: str,
    target_revision_arn: str,
    deployment_info: dict,
) -> dict:
    """
    Slack通知用メッセージを生成（Chatbot Custom Notification スキーマ準拠）

    https://docs.aws.amazon.com/chatbot/latest/adminguide/custom-notifs.html

    カスタムアクションで使用する変数:
    - ActionGroup: event.metadata.additionalContext.ActionGroup
    - parameterName: event.metadata.additionalContext.parameterName
    """

    account_id = deployment_info.get("accountId", "unknown")
    region = deployment_info.get("region", "unknown")
    cluster_name = deployment_info.get("clusterName", "unknown")
    service_name = deployment_info.get("serviceName", "unknown")
    deployment_id = deployment_info.get("deploymentId", "unknown")
    service_revision_url = deployment_info.get("serviceRevisionUrl", "#")

    description = (
        f"@channel\n\n"
        f"- *Account* : `{account_id}`\n"
        f"- *Region* : `{region}`\n"
        f"- *ECS Cluster* : `{cluster_name}`\n"
        f"- *ECS Service* : `{service_name}`\n"
        f"- *Deployment ID* : `{deployment_id}`\n"
        f"- *Service Revision URL* : {service_revision_url}\n\n"
        f"---\n"
        f"テストトラフィックが新しいリビジョンのタスクに正常に再ルーティングされました。\n"
        f"動作確認の上、本番トラフィックも新しいリビジョンのタスクに *再ルーティングするか* 、それとも *ロールバックするか* を選択してください。\n"
        f"選択は *24時間以内* に行う必要があります。24時間以内に再ルーティングしない場合は *自動でロールバック* が開始されます。\n\n"
        f"---\n"
        f"ref : \n"
        f"- <https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/blue-green-deployment-how-it-works.html|Amazon ECS ブルー/グリーンサービスのデプロイワークフロー - Amazon Elastic Container Service>"
        f"- <https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/deployment-lifecycle-hooks.html|Amazon ECS サービスデプロイのライフサイクルフック - Amazon Elastic Container Service>"
    )

    message = {
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
                "region": deployment_info.get("region", ""),
            },
            "enableCustomActions": True,
        },
    }

    return message
