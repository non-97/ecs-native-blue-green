import * as fs from "fs";
import * as path from "path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { EcsNativeBlueGreenStack } from "../lib/ecs-native-blue-green-stack";

// cdk.json の context (機能フラグ) をテスト側にも反映させる
const getContext = (): Record<string, any> => {
  const cdkJsonPath = path.join(__dirname, "..", "cdk.json");
  const cdkJson = JSON.parse(fs.readFileSync(cdkJsonPath, "utf-8"));
  return cdkJson.context ?? {};
};

const stackProps = {
  slackWorkspaceId: "T0A74KE0G78",
  slackChannelId: "C0A76LPE6FL",
};

const getTemplate = (): Template => {
  const app = new App({
    context: { ...getContext() },
  });
  const stack = new EcsNativeBlueGreenStack(
    app,
    "EcsNativeBlueGreenStack",
    stackProps
  );
  return Template.fromStack(stack);
};

// ============================================================================
// 1. Snapshot test (リグレッション検知)
// ============================================================================
describe("Snapshot", () => {
  test("CloudFormation テンプレートが既存スナップショットと一致する", () => {
    const template = getTemplate();
    expect(template.toJSON()).toMatchSnapshot();
  });
});

// ============================================================================
// 2. Fine-grained assertions (本プロジェクト固有の重要設定を保証)
// ============================================================================
describe("ECS Service PAUSE Lifecycle Hook", () => {
  // L1 escape hatch (addPropertyOverride) で注入している設定の検証
  test("POST_TEST_TRAFFIC_SHIFT に TargetType=PAUSE のフックが 1440分 ROLLBACK で設定される", () => {
    const template = getTemplate();
    template.hasResourceProperties("AWS::ECS::Service", {
      DeploymentConfiguration: {
        LifecycleHooks: [
          {
            TargetType: "PAUSE",
            LifecycleStages: ["POST_TEST_TRAFFIC_SHIFT"],
            TimeoutConfiguration: {
              TimeoutInMinutes: 1440,
              Action: "ROLLBACK",
            },
          },
        ],
      },
    });
  });

  test("Blue/Green デプロイ戦略 / Bake Time 1分 が指定される", () => {
    const template = getTemplate();
    template.hasResourceProperties("AWS::ECS::Service", {
      DeploymentConfiguration: {
        Strategy: "BLUE_GREEN",
        BakeTimeInMinutes: 1,
      },
    });
  });

  // CFn 制約: bakeTime + 各 LifecycleHook の Timeout の合計が 1980分以下
  test("Bake Time + Timeout の合計が CFn 上限 (1980分) 以下に収まる", () => {
    const template = getTemplate();
    const service = template.findResources("AWS::ECS::Service");
    const props = Object.values(service)[0].Properties as {
      DeploymentConfiguration: {
        BakeTimeInMinutes: number;
        LifecycleHooks: Array<{
          TimeoutConfiguration: { TimeoutInMinutes: number };
        }>;
      };
    };
    const total =
      props.DeploymentConfiguration.BakeTimeInMinutes +
      props.DeploymentConfiguration.LifecycleHooks.reduce(
        (sum, h) => sum + h.TimeoutConfiguration.TimeoutInMinutes,
        0
      );
    expect(total).toBeLessThanOrEqual(1980);
  });
});

describe("EventBridge Rule", () => {
  // CFn 依存関係のデッドロック回避のため、serviceArn は意図的にフィルタしない
  test("HOOK_AWAITING_ACTION / hookType=PAUSE / lifecycleStage / clusterArn でフィルタする", () => {
    const template = getTemplate();
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: {
        source: ["aws.ecs"],
        "detail-type": ["ECS Hook State Change"],
        detail: {
          eventName: ["HOOK_AWAITING_ACTION"],
          hookType: ["PAUSE"],
          lifecycleStage: ["POST_TEST_TRAFFIC_SHIFT"],
          clusterArn: [Match.anyValue()],
        },
      },
    });
  });

  // デッドロック回避のため、EventPattern には serviceArn を含めない
  test("EventPattern に serviceArn が含まれていない (CFn 依存ループ回避)", () => {
    const template = getTemplate();
    const rules = template.findResources("AWS::Events::Rule");
    const ourRule = Object.values(rules).find((r) =>
      JSON.stringify((r.Properties as any).EventPattern).includes(
        "HOOK_AWAITING_ACTION"
      )
    );
    expect(ourRule).toBeDefined();
    expect(
      JSON.stringify((ourRule!.Properties as any).EventPattern)
    ).not.toContain("serviceArn");
  });

  test("ターゲットが Step Functions State Machine になっている", () => {
    const template = getTemplate();
    template.hasResourceProperties("AWS::Events::Rule", {
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: Match.objectLike({
            Ref: Match.stringLikeRegexp("StateMachine"),
          }),
        }),
      ]),
    });
  });

  // Rule が Service より先に作成されることを CFn の DependsOn で担保
  test("Service が EventBridge Rule に DependsOn 依存している", () => {
    const template = getTemplate();
    const services = template.findResources("AWS::ECS::Service");
    const service = Object.values(services)[0];
    const dependsOn = (service as any).DependsOn as string[] | undefined;
    expect(dependsOn).toBeDefined();
    expect(dependsOn!.some((id) => /HookAwaitingActionRule/.test(id))).toBe(
      true
    );
  });
});

describe("Step Functions State Machine", () => {
  test("Standard ワークフロー / X-Ray トレース有効", () => {
    const template = getTemplate();
    template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
      StateMachineType: "STANDARD",
      TracingConfiguration: { Enabled: true },
    });
  });

  test("State Machine ロールに ECS Describe 系の権限が付与される (continueServiceDeployment は含まない)", () => {
    const template = getTemplate();
    // CallAwsService が出力するアクション名は camelCase
    const policies = template.findResources("AWS::IAM::Policy");
    const stateMachinePolicy = Object.values(policies).find((p) => {
      const actions = (p.Properties as any).PolicyDocument.Statement.flatMap(
        (s: any) => (Array.isArray(s.Action) ? s.Action : [s.Action])
      ) as string[];
      return (
        actions.includes("ecs:describeServices") &&
        actions.includes("ecs:describeServiceDeployments")
      );
    });
    expect(stateMachinePolicy).toBeDefined();
    const allActions = (
      stateMachinePolicy!.Properties as any
    ).PolicyDocument.Statement.flatMap((s: any) =>
      Array.isArray(s.Action) ? s.Action : [s.Action]
    ) as string[];
    // Step Functions が ecs:ContinueServiceDeployment を呼ばないこと
    // (Step Functions の SDK Integration が未サポートのため Slack 側 CLI に委譲)
    expect(allActions).not.toContain("ecs:continueServiceDeployment");
  });

  test("State Machine 定義に JSONata が使われており、ARN を $split で分解する", () => {
    const template = getTemplate();
    const sm = Object.values(
      template.findResources("AWS::StepFunctions::StateMachine")
    )[0];
    const def = (sm.Properties as any).DefinitionString["Fn::Join"][1] as Array<
      string | object
    >;
    const fullDef = def
      .filter((p): p is string => typeof p === "string")
      .join("");
    expect(fullDef).toContain('"QueryLanguage":"JSONata"');
    expect(fullDef).toContain("$split($states.input.detail.serviceDeploymentArn");
    expect(fullDef).toContain("aws-sdk:ecs:describeServices");
    expect(fullDef).toContain("aws-sdk:ecs:describeServiceDeployments");
    // Step Functions が ContinueServiceDeployment を呼ばないことを ASL レベルでも確認
    expect(fullDef).not.toContain("continueServiceDeployment");
  });
});

describe("SNS Topic / 連携", () => {
  test("通知用 SNS Topic が 1 つ存在する", () => {
    const template = getTemplate();
    template.resourceCountIs("AWS::SNS::Topic", 1);
  });

  test("Slack Channel Configuration が SNS Topic を購読する", () => {
    const template = getTemplate();
    template.hasResourceProperties(
      "AWS::Chatbot::SlackChannelConfiguration",
      {
        SnsTopicArns: Match.arrayWith([
          Match.objectLike({ Ref: Match.stringLikeRegexp("Topic") }),
        ]),
      }
    );
  });
});

describe("Amazon Q Developer in chat applications", () => {
  // 本プロジェクトの本丸: ボタンクリックで実行される CLI コマンド
  test("再ルーティングボタンの commandText が CONTINUE", () => {
    const template = getTemplate();
    template.hasResourceProperties("AWS::Chatbot::CustomAction", {
      ActionName: "PostTestTrafficShiftApprove",
      Definition: {
        CommandText:
          "ecs continue-service-deployment --service-deployment-arn $serviceDeploymentArn --hook-id $hookId --action CONTINUE --region $region",
      },
    });
  });

  test("ロールバックボタンの commandText が ROLLBACK", () => {
    const template = getTemplate();
    template.hasResourceProperties("AWS::Chatbot::CustomAction", {
      ActionName: "PostTestTrafficShiftReject",
      Definition: {
        CommandText:
          "ecs continue-service-deployment --service-deployment-arn $serviceDeploymentArn --hook-id $hookId --action ROLLBACK --region $region",
      },
    });
  });

  test("カスタムアクションの criteria が ActionGroup と hookId で絞り込まれている", () => {
    const template = getTemplate();
    template.hasResourceProperties("AWS::Chatbot::CustomAction", {
      Attachments: Match.arrayWith([
        Match.objectLike({
          Criteria: Match.arrayWith([
            { Operator: "HAS_VALUE", VariableName: "hookId" },
            {
              Operator: "EQUALS",
              VariableName: "ActionGroup",
              Value: "ecs-blue-green-deployment_POST_TEST_TRAFFIC_SHIFT",
            },
          ]),
        }),
      ]),
    });
  });

  test("Slack ワークスペース ID / チャンネル ID が props から流入する", () => {
    const template = getTemplate();
    template.hasResourceProperties(
      "AWS::Chatbot::SlackChannelConfiguration",
      {
        SlackWorkspaceId: stackProps.slackWorkspaceId,
        SlackChannelId: stackProps.slackChannelId,
      }
    );
  });

  test("Chatbot ロール / ガードレールに ecs:ContinueServiceDeployment が付与される", () => {
    const template = getTemplate();
    // チャンネルロールに付与されるインライン Policy
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ecs:ContinueServiceDeployment",
            Effect: "Allow",
            Resource: "*",
          }),
        ]),
      },
    });
    // ガードレールマネージドポリシー
    template.hasResourceProperties("AWS::IAM::ManagedPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ecs:ContinueServiceDeployment",
            Effect: "Allow",
            Resource: "*",
          }),
        ]),
      },
    });
  });
});

describe("旧構成 (Lambda + SSM ポーリング) のリグレッション防止", () => {
  test("承認ハンドラ Lambda 関数が存在しない (CDK 内部の Custom Resource 用 Lambda は除く)", () => {
    const template = getTemplate();
    const lambdas = template.findResources("AWS::Lambda::Function");
    const approvalLambda = Object.entries(lambdas).find(([logicalId]) =>
      /[Aa]pproval/.test(logicalId)
    );
    expect(approvalLambda).toBeUndefined();
  });

  test("SSM Parameter (ecs-native-blue-green-approval) を作成していない", () => {
    const template = getTemplate();
    const params = template.findResources("AWS::SSM::Parameter");
    const approvalParam = Object.entries(params).find(([, v]) =>
      JSON.stringify((v.Properties as any).Name ?? "").includes(
        "ecs-native-blue-green-approval"
      )
    );
    expect(approvalParam).toBeUndefined();
  });
});
