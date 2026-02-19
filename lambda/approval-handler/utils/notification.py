def create_approval_message(
    bucket_name: str,
    revision_id: str,
    service_arn: str,
    target_revision_arn: str,
    deployment_info: dict,
) -> dict:
    """
    Slack通知用メッセージを生成（Chatbot Custom Notification スキーマ準拠）

    https://docs.aws.amazon.com/chatbot/latest/adminguide/custom-notifs.html

    カスタムアクションで使用する変数:
    - bucketName: metadata.additionalContext.bucketName
    - revisionId: metadata.additionalContext.revisionId
    """

    account_id = deployment_info.get("accountId", "unknown")
    region = deployment_info.get("region", "unknown")
    cluster_name = deployment_info.get("clusterName", "unknown")
    service_name = deployment_info.get("serviceName", "unknown")
    deployment_id = deployment_info.get("deploymentId", "unknown")
    service_revision_url = deployment_info.get("serviceRevisionUrl", "#")

    description = (
        f"*Account*: `{account_id}`\n"
        f"*Region*: `{region}`\n"
        f"*Cluster*: `{cluster_name}`\n"
        f"*Service*: `{service_name}`\n"
        f"*Deployment ID*: `{deployment_id}`\n"
        f"*Service Revision*: {service_revision_url}\n\n"
        f"Test traffic has been successfully shifted to the new task revision.\n"
        f"Please review and approve or reject this deployment."
    )

    message = {
        "version": "1.0",
        "source": "custom",
        "content": {
            "textType": "client-markdown",
            "title": ":rocket: ECS Blue/Green Deployment - Approval Required",
            "description": description,
            "keywords": [cluster_name, service_name],
        },
        "metadata": {
            "additionalContext": {
                "bucketName": bucket_name,
                "revisionId": revision_id,
            },
            "enableCustomActions": True,
        },
    }

    return message
