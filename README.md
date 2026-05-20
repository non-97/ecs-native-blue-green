# ECS Native Blue/Green Deployment with PAUSE Lifecycle Hook

Amazon ECS のネイティブ Blue/Green デプロイメントに **PAUSE 型ライフサイクルフック** (2026年5月リリース) を組み合わせ、本番トラフィック切り替え前に Slack で人手承認を挟むサンプル CDK プロジェクトです。

Lambda 関数による承認ハンドラ / SSM Parameter Store ポーリング機構を廃止し、**Step Functions (JSONata) + EventBridge + Amazon Q Developer in chat applications** だけで承認フローを実現しています。

## アーキテクチャ概要

```
[ECS Service (Blue/Green)]
    │
    │ POST_TEST_TRAFFIC_SHIFT で PAUSE
    ↓ HOOK_AWAITING_ACTION イベント
[EventBridge Rule] (clusterArn / serviceArn でフィルタ)
    ↓
[Step Functions Standard Workflow (JSONata)]
    1. ParseArns                 : ARN を分解
    2. DescribeServices          : Bake Time / Timeout を取得
    3. DescribeServiceDeployments: Revision ID を取得
    4. BuildMessage              : Chatbot Custom Notification JSON を組み立て
    5. SNS Publish
    ↓
[Amazon Q Developer in chat applications]
    ↓ Slack 通知
[ユーザーが Slack のカスタムアクションボタンをクリック]
    ├ 🔁 再ルーティング: aws ecs continue-service-deployment --action CONTINUE
    └ ⏪ ロールバック  : aws ecs continue-service-deployment --action ROLLBACK
```

主要コンポーネント:

- **VPC / ALB / Fargate Service** (Blue/Green デプロイ戦略)
- **Aurora PostgreSQL Serverless v2** (アプリの DB)
- **ElastiCache for Valkey Serverless** (キャッシュ)
- **FireLens (Fluent Bit init image)** + **Kinesis Data Firehose** + **S3** (ログ集約)
- **ADOT Collector サイドカー** (Application Signals / Prometheus メトリクス)
- **PAUSE Lifecycle Hook** (本番再ルーティング前の一時停止)
- **EventBridge Rule → Step Functions (JSONata) → SNS** (通知メッセージ整形)
- **Amazon Q Developer in chat applications** (Slack 通知 + 承認ボタン)

## ディレクトリ構成

```
.
├── bin/
│   └── ecs-native-blue-green.ts        # CDK エントリポイント
├── lib/
│   ├── ecs-native-blue-green-stack.ts  # メインスタック
│   └── construct/
│       ├── vpc-construct.ts
│       ├── alb-construct.ts
│       ├── aurora-construct.ts
│       ├── valkey-construct.ts
│       ├── firelens-construct.ts
│       ├── ecs-construct.ts                       # ECS Service + PAUSE hook
│       ├── deployment-notification-construct.ts   # EventBridge + Step Functions + SNS
│       ├── q-developer-chat-construct.ts          # Slack 通知 + 承認ボタン
│       └── bucket-construct.ts
└── src/
    ├── container/
    │   ├── app/   # Node.js アプリ (Express)
    │   └── web/   # nginx
    ├── fluentbit-config/   # Fluent Bit 追加設定
    └── otel-config/        # ADOT Collector 設定 (App Signals あり / なし)
```

## デプロイ手順

```bash
# 依存パッケージインストール
pnpm install

# Slack ワークスペース / チャンネル ID を bin/ecs-native-blue-green.ts に記載

# AWS 認証 (awsume を使用)
awsume <profile>
aws sts get-caller-identity

# Bootstrap (初回のみ)
pnpm cdk bootstrap

# デプロイ
pnpm cdk deploy
```

事前に Amazon Q Developer in chat applications のコンソールから Slack ワークスペースを承認しておく必要があります。

## 重要な設定値

| 項目 | 値 | 場所 |
|---|---|---|
| Blue/Green Lifecycle Stage | `POST_TEST_TRAFFIC_SHIFT` | `ecs-construct.ts` |
| PAUSE Hook Timeout | 1440 分 (1日) | `ecs-construct.ts` |
| Timeout Action | `ROLLBACK` | `ecs-construct.ts` |
| Bake Time | 1 分 | `ecs-construct.ts` |
| Step Functions タイプ | Standard | `deployment-notification-construct.ts` |
| Query Language | JSONata | `deployment-notification-construct.ts` |

## 設計上の制約と注意点

このプロジェクトをそのまま利用 / カスタマイズする際に知っておくと役立つ AWS / CDK 側の仕様をまとめます。

### 初回デプロイも Slack 承認が必要

旧 Blue/Green が存在しない初回デプロイでも PAUSE フックは発火するため、**Slack 通知が飛び、ユーザーが CONTINUE ボタンを押す** 必要があります。本プロジェクトでは Step Functions 側で初回デプロイの自動 CONTINUE は行いません。

理由は **Step Functions の AWS SDK Integration が `ecs:ContinueServiceDeployment` (2026年5月リリース) をまだサポートしておらず**、`arn:aws:states:::aws-sdk:ecs:continueServiceDeployment` を指定するとデプロイ時に `is not recognized` エラーになるためです。自動 CONTINUE が必要であれば、Lambda 経由で `ContinueServiceDeploymentCommand` (AWS SDK v3) を呼ぶ実装を追加してください。

### PAUSE フックの timeout は最大 1980 分 (33時間)

ECS API レベルでは PAUSE フックの timeout は最大 14日 (20160分) 設定可能ですが、**CloudFormation 経由でデプロイする場合は `bakeTimeInMinutes + 各 LifecycleHook の TimeoutInMinutes の合計が 1980 分 (33時間) 以下` でなければなりません** 。超過すると以下のエラーになります。

```
Total bake time (X minutes) for progressive deployment exceeds the Cloudformation limit of 33 hours.
```

本プロジェクトは bake time 1分 + timeout 1440分 (1日) = 1441分 で制約内に収めています。timeout を変更する際はこの制約に注意してください。1日を超える timeout が必要な場合は CDK / CFn ではなく AWS CLI / SDK で直接 ECS API を叩く必要があります。

### EventBridge Rule の EventPattern で Service ARN を参照すると CFn デッドロック

EventPattern に `serviceArn: [props.service.serviceArn]` のように Service ARN を埋め込むと **致命的なデッドロック** が発生します。

```
1. CFn が Service を作成開始
2. Service の Blue/Green デプロイが POST_TEST_TRAFFIC_SHIFT で PAUSE
3. Service の CREATE_IN_PROGRESS が解除されない
4. EventBridge Rule は Service ARN を Ref しているため CFn 暗黙依存により Service の CREATE_COMPLETE 待ち
5. Rule が作成されないので PAUSE 通知が誰にも届かない
6. PAUSE 解除する人がいない → 1日後にタイムアウトでロールバック → CFn は CREATE_FAILED
```

**対策**: 2点セットで適用します。

1. **EventPattern では Service ARN を参照しない**。代わりに **Cluster ARN + lifecycleStage** でフィルタする。Cluster は Service に依存しないため、Rule は Service より先に作成可能。

```typescript
new cdk.aws_events.Rule(this, "HookAwaitingActionRule", {
  eventPattern: {
    source: ["aws.ecs"],
    detailType: ["ECS Hook State Change"],
    detail: {
      eventName: ["HOOK_AWAITING_ACTION"],
      hookType: ["PAUSE"],
      lifecycleStage: ["POST_TEST_TRAFFIC_SHIFT"],
      clusterArn: [props.cluster.clusterArn],  // Cluster のみ参照
    },
  },
  targets: [...],
});
```

2. **Service が Rule に明示的依存** するよう CFn の DependsOn を強制する。これにより Rule + State Machine + SNS Topic が全て CREATE_COMPLETE になってから Service の作成が始まる。

```typescript
ecsConstruct.service.node.addDependency(deploymentNotification);
```

### PAUSE Lifecycle Hook は CDK L2 では設定不可

CDK の `service.addLifecycleHook()` は `DeploymentLifecycleLambdaTarget` (Lambda 型) しか受け付けません。PAUSE 型は **L1 escape hatch** で設定します。

```typescript
const cfnService = service.node.defaultChild as cdk.aws_ecs.CfnService;
cfnService.addPropertyOverride("DeploymentConfiguration.LifecycleHooks", [
  {
    TargetType: "PAUSE",
    LifecycleStages: ["POST_TEST_TRAFFIC_SHIFT"],
    TimeoutConfiguration: {
      TimeoutInMinutes: 1440,
      Action: "ROLLBACK",
    },
  },
]);
```

### EventBridge Input Transformer の制約と Step Functions 採用理由

通知メッセージの整形に EventBridge Input Transformer を直接使うと **文字列の split / substring / replace ができない** ため、`serviceDeploymentArn` から cluster 名 / service 名 / deployment ID を取り出してコンソール URL を組み立てられません。

このプロジェクトでは EventBridge ターゲットを Step Functions Standard Workflow (JSONata) にし、`$split()` / `$count()` / `$string()` などの組み込み関数で ARN を分解しています。

### CDK `CallAwsService` のパラメータ指定方法

JSONata モードの ASL では `Arguments` フィールドにパラメータを渡しますが、CDK の `CallAwsService` 側は **JSONPath / JSONata どちらでも `parameters` プロパティを使う** 仕様です。`arguments` を指定すると TypeScript の型エラーになります。

```typescript
// NG
CallAwsService.jsonata(this, "X", {
  arguments: { ... },  // ❌ TS2353
});

// OK
CallAwsService.jsonata(this, "X", {
  parameters: { ... },  // ✅ 内部で Arguments に変換される
});
```

CDK 内部の `_renderParametersOrArguments` がクエリ言語に応じて `Parameters` / `Arguments` を切り替えます。

### PAUSE Hook の `targetType` / `timeoutConfiguration` は DescribeServices で取得不可

`ecs:DescribeServices` の `services[].deploymentConfiguration.lifecycleHooks[]` は、**PAUSE 型フックの場合 `lifecycleStages` のみ** が返り `targetType` / `timeoutConfiguration` は含まれません。

```jsonc
"lifecycleHooks": [
  { "lifecycleStages": ["POST_TEST_TRAFFIC_SHIFT"] }
  // ← targetType も timeoutConfiguration も無い
]
```

通知メッセージに timeout を表示したい場合は、DescribeServices からは取れないので **EventBridge イベントの `detail.expiresAt`** (タイムアウトの絶対時刻、ISO8601) を使います。本プロジェクトもこの方式を採用しています。

### ECS Hook State Change イベントのフィールド

PAUSE フック発火時の EventBridge イベント (`detail-type: "ECS Hook State Change"`) で利用可能な主要フィールド:

| フィールド | 例 |
|---|---|
| `eventName` | `HOOK_AWAITING_ACTION` (PAUSE 固有、フィルタリング推奨) |
| `hookId` | `ecs-pause-e7tK9G_WRJqNF_...` (`continue-service-deployment --hook-id` で使用) |
| `hookType` | `PAUSE` |
| `lifecycleStage` | `POST_TEST_TRAFFIC_SHIFT` 等 |
| `expiresAt` | タイムアウト時刻 (ISO8601) |
| `clusterArn` / `serviceArn` / `serviceDeploymentArn` | フル ARN |

cluster 名 / service 名 / revision ID 単体フィールドは存在しないため、ARN を `$split()` で分割します。  
さらに revision ID は ARN にも含まれないため、`DescribeServiceDeployments` API を別途呼んで `TargetServiceRevision.Arn` の末尾を抽出する実装にしています。

```jsonata
$split($states.result.ServiceDeployments[0].TargetServiceRevision.Arn, '/')[3]
```

### Amazon Q Developer in chat applications カスタムアクションの注意点

- `commandText` の先頭に `aws` は **不要** (例: `ecs continue-service-deployment --hook-id ...`)
- `--overwrite` フラグを指定すると Q Developer が CLI 実行ではなく AI による解説モードに切り替わってしまう挙動があるため使用しない
- カスタムアクションは `CfnSlackChannelConfiguration.customizationResourceArns` で Slack チャンネルに関連付ける必要がある
- アクション実行に必要な IAM 権限は **チャンネルロール** と **ガードレールポリシー** の両方に同じ権限を付与する必要がある
- **CLI コマンドの必須パラメータが揃っていないと Q Developer は実行せず `I can't answer that question` という AI 応答にフォールバック** する。例えば `aws ecs continue-service-deployment` は `--service-deployment-arn` と `--hook-id` の両方が必須 (リリース直後の AWS 公式アナウンスや `What's New` 記事には `--hook-id` だけのサンプルが載っていたが、実際は両方必要なので注意)。`metadata.additionalContext` に必要な変数を全て載せ、commandText からも全て参照する。
- **Q Developer がサポートしていない新しい AWS CLI コマンドも `I can't answer that question.` を返す**。本プロジェクト時点 (2026年5月) では `ecs continue-service-deployment` がローカル AWS CLI (2.34.50+) で実行可能でも、Q Developer 内部の CLI には未追加だった。通知メッセージ側に「Q Developer がエラーになった場合は AWS マネジメントコンソールから手動操作 or AWS CLI を直接実行」というフォールバック手順を載せておくのが堅実。

## 関連ブログ記事

このリポジトリで採用している各要素について、より詳細な解説は以下を参照してください。

- [ECS のネイティブ Blue/Green Deployment とライフサイクルフックで本番トラフィックの切り替え前に Amazon Q Developer in chat applications で承認させる](https://dev.classmethod.jp/articles/ecs-native-blue-green-deployment-lifecycle-hooks-amazon-q-developer-slack/)
  - 本記事の「旧構成」 (Lambda + SSM Parameter Store ポーリング) の解説。本プロジェクトは PAUSE フックでこれを置き換えています
- [CloudWatch Application Signals を ADOT Collector + ADOT SDK で利用する](https://dev.classmethod.jp/articles/cloudwatch-application-signals-with-adot-collector-and-sdk/)
  - 本リポジトリの `enableApplicationSignals` で行っている設定の詳細
- [AWS FireLens で Prometheus メトリクスを ADOT Collector 経由で CloudWatch に送る](https://dev.classmethod.jp/articles/aws-firelens-prometheus-metrics-adot-collector-cloudwatch/)
  - `enableFluentBitMetrics` で送出している Prometheus メトリクスの仕組み
- [AWS FireLens から Data Firehose の Dynamic Partitioning を使って S3 にログを集約する](https://dev.classmethod.jp/articles/aws-firelens-to-s3-with-data-firehose-dynamic-partitioning/)
  - `firelens-construct.ts` の Firehose 連携部分の詳細
- [AWS FireLens (Fluent Bit) で 16KB を超える大きいログを 1 行として扱う](https://dev.classmethod.jp/articles/aws-firelens-fluent-bit-large-logs-over-16kb/)
  - `src/fluentbit-config/extra.conf` で行っているマルチライン処理の背景

## 参考公式ドキュメント

- [Amazon ECS pause/continue deployments (What's New, 2026-05)](https://aws.amazon.com/about-aws/whats-new/2026/05/amazon-ecs-pause-continue-deployments/)
- [Pause lifecycle hooks - Amazon ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/pause-lifecycle-hooks.html)
- [ContinueServiceDeployment API - Amazon ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/continue-service-deployment.html)
- [ECS Hook State Change EventBridge イベント](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_hook_state_change_events.html)
- [Step Functions の AWS SDK Integration 対応サービス](https://docs.aws.amazon.com/step-functions/latest/dg/supported-services-awssdk.html)
- [JSONata 組み込み関数 (Step Functions)](https://docs.aws.amazon.com/step-functions/latest/dg/transforming-data.html)
