import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface DeploymentNotificationConstructProps {
  /**
   * 監視対象 ECS クラスター
   *
   * EventBridge Rule の EventPattern に `serviceArn` を埋め込むと
   * 「Service が PAUSE で停止 → Service が CREATE_COMPLETE にならない → Rule が未作成」
   * というデッドロックが発生するため、Service ARN ではなく Cluster ARN でフィルタする。
   * Cluster は Service に依存しないため、Rule は Service より先に作成可能。
   * さらに `service.node.addDependency(deploymentNotification)` をスタック側で追加し、
   * Rule が必ず Service より先に作成されることを担保する。
   */
  cluster: cdk.aws_ecs.ICluster;
}

/**
 * ECS Blue/Green PAUSE ライフサイクルフック向け通知 Construct
 *
 * 構成:
 *   EventBridge Rule (HOOK_AWAITING_ACTION) → Step Functions (JSONata) → SNS
 *
 * Step Functions では:
 *   1. ARN から cluster / service / deployment ID を抽出
 *   2. DescribeServices で bakeTime / timeout を取得
 *   3. DescribeServiceDeployments で revisionId を取得
 *   4. Chatbot Custom Notification を SNS に Publish
 *
 * 初回デプロイの自動承認は実装しない (Slack ボタンで CONTINUE する Q1 方針)。
 * 実際の continue-service-deployment は Q Developer Chat 側の AWS CLI 呼び出しが担当する。
 *
 * SNS Topic は Q Developer Chat 側で購読される。
 */
export class DeploymentNotificationConstruct extends Construct {
  /** Chatbot 経由の通知配信先 */
  public readonly notificationTopic: cdk.aws_sns.ITopic;

  constructor(
    scope: Construct,
    id: string,
    props: DeploymentNotificationConstructProps
  ) {
    super(scope, id);

    this.notificationTopic = new cdk.aws_sns.Topic(this, "Topic");

    const stateMachine = this.createStateMachine(this.notificationTopic);

    new cdk.aws_events.Rule(this, "HookAwaitingActionRule", {
      eventPattern: {
        source: ["aws.ecs"],
        detailType: ["ECS Hook State Change"],
        detail: {
          eventName: ["HOOK_AWAITING_ACTION"],
          hookType: ["PAUSE"],
          lifecycleStage: ["POST_TEST_TRAFFIC_SHIFT"],
          clusterArn: [props.cluster.clusterArn],
        },
      },
      targets: [new cdk.aws_events_targets.SfnStateMachine(stateMachine)],
    });
  }

  private createStateMachine(
    topic: cdk.aws_sns.ITopic
  ): cdk.aws_stepfunctions.StateMachine {
    const parseArns = cdk.aws_stepfunctions.Pass.jsonata(this, "ParseArns", {
      assign: {
        region: "{% $states.input.region %}",
        account: "{% $states.input.account %}",
        hookId: "{% $states.input.detail.hookId %}",
        expiresAt: "{% $states.input.detail.expiresAt %}",
        serviceDeploymentArn: "{% $states.input.detail.serviceDeploymentArn %}",
        clusterName:
          "{% $split($states.input.detail.clusterArn, '/')[1] %}",
        serviceName:
          "{% $split($states.input.detail.serviceArn, '/')[2] %}",
        deploymentId:
          "{% $split($states.input.detail.serviceDeploymentArn, '/')[3] %}",
      },
    });

    const describeServices =
      cdk.aws_stepfunctions_tasks.CallAwsService.jsonata(
        this,
        "DescribeServices",
        {
          service: "ecs",
          action: "describeServices",
          iamResources: ["*"],
          parameters: {
            Cluster: "{% $clusterName %}",
            Services: ["{% $serviceName %}"],
          },
          assign: {
            bakeTimeInMinutes:
              "{% $states.result.Services[0].DeploymentConfiguration.BakeTimeInMinutes %}",
          },
        }
      );
    describeServices.addRetry({
      errors: ["States.ALL"],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2.0,
    });

    const describeServiceDeployments =
      cdk.aws_stepfunctions_tasks.CallAwsService.jsonata(
        this,
        "DescribeServiceDeployments",
        {
          service: "ecs",
          action: "describeServiceDeployments",
          iamResources: ["*"],
          parameters: {
            ServiceDeploymentArns: ["{% $serviceDeploymentArn %}"],
          },
          assign: {
            revisionId:
              "{% $split($states.result.ServiceDeployments[0].TargetServiceRevision.Arn, '/')[3] %}",
          },
        }
      );
    describeServiceDeployments.addRetry({
      errors: ["States.ALL"],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2.0,
    });

    const buildMessage = cdk.aws_stepfunctions.Pass.jsonata(
      this,
      "BuildMessage",
      {
        assign: {
          snsMessage: this.buildSnsMessageJsonata(),
        },
      }
    );

    const publish = cdk.aws_stepfunctions_tasks.SnsPublish.jsonata(
      this,
      "Publish",
      {
        topic,
        subject:
          "ECS Blue/Green Deployment - 本番トラフィックの再ルーティング",
        message: cdk.aws_stepfunctions.TaskInput.fromText("{% $snsMessage %}"),
      }
    );
    publish.addRetry({
      errors: ["States.ALL"],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2.0,
    });

    const definition = parseArns
      .next(describeServices)
      .next(describeServiceDeployments)
      .next(buildMessage)
      .next(publish);

    return new cdk.aws_stepfunctions.StateMachine(this, "StateMachine", {
      definitionBody:
        cdk.aws_stepfunctions.DefinitionBody.fromChainable(definition),
      stateMachineType: cdk.aws_stepfunctions.StateMachineType.STANDARD,
      timeout: cdk.Duration.minutes(5),
      tracingEnabled: true,
    });
  }

  /**
   * SNS に Publish する Chatbot Custom Notification JSON を構築する JSONata 式。
   * 最終的に `$string(...)` で文字列化して assign する。
   */
  private buildSnsMessageJsonata(): string {
    const description = [
      "'@channel\\n\\n'",
      "'- *Account* : `' & $account & '`\\n'",
      "'- *Region* : `' & $region & '`\\n'",
      "'- *ECS Cluster* : `' & $clusterName & '`\\n'",
      "'- *ECS Service* : `' & $serviceName & '`\\n'",
      "'- *Service Revision ID* : `' & $revisionId & '`\\n'",
      "'- *Service Deployment ID* : `' & $deploymentId & '`\\n'",
      "'- *Service Deployment URL* : https://' & $region & '.console.aws.amazon.com/ecs/v2/clusters/' & $clusterName & '/services/' & $serviceName & '/service-deployments/' & $deploymentId & '?region=' & $region & '\\n'",
      "'- *Bake Time* : `' & $string($bakeTimeInMinutes) & ' 分`\\n'",
      "'- *Expires At* : `' & $expiresAt & '`\\n\\n'",
      "'---\\n'",
      "'テストトラフィックが新しいリビジョンのタスクに正常に再ルーティングされました。\\n'",
      "'動作確認の上、本番トラフィックも新しいリビジョンのタスクに *再ルーティングするか* 、それとも *ロールバックするか* を選択してください。\\n'",
      "'*Expires At* を超過すると *自動でロールバック* が開始されます。\\n\\n'",
      "'---\\n'",
      "'動作補足 : \\n\\n'",
      "'POST_TEST_TRAFFIC_SHIFT の PAUSE ライフサイクルフックにより、本番トラフィック切り替え前にデプロイが一時停止されています。\\n'",
      "'ボタンをクリックすると `aws ecs continue-service-deployment` API が実行され、CONTINUE / ROLLBACK が指示されます。\\n\\n'",
      '"⚠️ Q Developer が `I can\'t answer that question.` を返した場合 (= `ecs continue-service-deployment` API が Q Developer のサポートコマンドに未追加の場合) は、以下のいずれかで対応してください:\\n"',
      "'1. *Service Deployment URL* から AWS マネジメントコンソールにログインして手動で *再ルーティング* / *ロールバック* を実行する。\\n'",
      "'2. ボタンをクリックした時に Q Developer が表示する AWS CLI コマンドをコピーし、ローカル環境やCloudShell から直接実行する。\\n'",
      "'---\\n'",
      "'ref : \\n'",
      "'- <https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/blue-green-deployment-how-it-works.html|Amazon ECS ブルー/グリーンサービスのデプロイワークフロー - Amazon Elastic Container Service>\\n'",
      "'- <https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/pause-lifecycle-hooks.html|Amazon ECS デプロイの一時停止ライフサイクルフック - Amazon Elastic Container Service>'",
    ].join(" & ");

    const payload = `{
      "version": "1.0",
      "source": "custom",
      "content": {
        "textType": "client-markdown",
        "title": ":rocket: ECS Blue/Green Deployment - 本番トラフィックの再ルーティング承認依頼",
        "description": ${description}
      },
      "metadata": {
        "additionalContext": {
          "ActionGroup": "ecs-blue-green-deployment_POST_TEST_TRAFFIC_SHIFT",
          "hookId": $hookId,
          "serviceDeploymentArn": $serviceDeploymentArn,
          "region": $region
        },
        "enableCustomActions": true
      }
    }`;

    return `{% $string(${payload}) %}`;
  }
}
