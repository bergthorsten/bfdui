import { SiGithub } from "@icons-pack/react-simple-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  CircleX,
  Clipboard,
  ExternalLink,
  FolderGit2,
  KeyRound,
  Loader2,
  RefreshCw,
  Rocket,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import {
  type ChangeEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  checkBfdEnvironment,
  getBfdConfig,
  saveBfdConfig,
  testBfdConnection,
} from "@/actions/bfd";
import { openExternalLink } from "@/actions/shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type {
  AppConfig,
  ConnectionResult,
  EnvironmentToolCheck,
  EnvironmentToolStatus,
  SecretStatus,
} from "@/types/bfd";
import { cn } from "@/utils/tailwind";

type ConnectionKind = "argo" | "github" | "jira" | "repo";

const ONBOARDING_SCREENS = [
  {
    description:
      "Check the local CLIs, workspace path, and Kubernetes access in one pass.",
    title: "System check & workspace",
  },
  {
    description:
      "Connect Jira and GitHub, review automatic checks, then enter BFD.",
    title: "Accounts & ready check",
  },
] as const;

const REQUIRED_TOOL_STATUSES = new Set<EnvironmentToolStatus>([
  "missing",
  "warning",
]);

const EMPTY_SECRET_STATUS: SecretStatus = {
  githubToken: false,
  jiraToken: false,
};

interface AutomaticConnectionTest {
  key: string;
  kind: Extract<ConnectionKind, "argo" | "github">;
}

interface TestingState {
  argo?: boolean;
  github?: boolean;
  jira?: boolean;
  repo?: boolean;
}

function readyToolAutomaticTests(
  tools: EnvironmentToolCheck[],
  config: AppConfig,
  checkedAt: number
): AutomaticConnectionTest[] {
  const isReady = (name: EnvironmentToolCheck["name"]) =>
    tools.some((tool) => tool.name === name && tool.status === "ok");
  const tests: AutomaticConnectionTest[] = [];

  if (
    config.github.useGhCli &&
    isReady("gh") &&
    config.github.owner.trim() &&
    config.github.repo.trim()
  ) {
    tests.push({
      key: `github:${checkedAt}:${config.github.owner}:${config.github.repo}`,
      kind: "github",
    });
  }

  if (
    isReady("argocd") &&
    isReady("kubectl") &&
    config.argo.app.trim() &&
    config.argo.devContext.trim()
  ) {
    tests.push({
      key: `argo:${checkedAt}:${config.argo.app}:${config.argo.devContext}`,
      kind: "argo",
    });
  }

  return tests;
}

export default function OnboardingGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [complete, setComplete] = useState(false);
  const configQuery = useQuery({
    queryKey: ["bfd", "config"],
    queryFn: getBfdConfig,
    retry: false,
  });

  if (complete || configQuery.data?.config.onboardingComplete) {
    return children;
  }

  if (!configQuery.data && configQuery.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading setup
      </div>
    );
  }

  if (!configQuery.data) {
    return children;
  }

  return (
    <OnboardingWizard
      initialConfig={configQuery.data.config}
      initialSecrets={configQuery.data.secrets}
      onComplete={() => {
        setComplete(true);
        queryClient.invalidateQueries({ queryKey: ["bfd", "config"] });
      }}
    />
  );
}

function OnboardingWizard({
  initialConfig,
  initialSecrets,
  onComplete,
}: {
  initialConfig: AppConfig;
  initialSecrets: SecretStatus;
  onComplete: () => void;
}) {
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState(initialConfig);
  const [secrets, setSecrets] = useState(initialSecrets ?? EMPTY_SECRET_STATUS);
  const [githubToken, setGithubToken] = useState("");
  const [jiraToken, setJiraToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<ConnectionResult | null>(null);
  const [testing, setTesting] = useState<TestingState>({});
  const [testResults, setTestResults] = useState<
    Partial<Record<ConnectionKind, ConnectionResult>>
  >({});
  const configRef = useRef(config);
  const autoTestKeysRef = useRef(new Set<string>());
  const mountedRef = useRef(true);

  const environmentQuery = useQuery({
    queryKey: ["bfd", "environment"],
    queryFn: checkBfdEnvironment,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const missingToolCount = useMemo(
    () =>
      environmentQuery.data?.tools.filter((tool) =>
        REQUIRED_TOOL_STATUSES.has(tool.status)
      ).length ?? 0,
    [environmentQuery.data]
  );
  const progress = ((step + 1) / ONBOARDING_SCREENS.length) * 100;

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const draftSecrets = useCallback(
    () => ({
      githubToken: githubToken.trim() || undefined,
      jiraToken: jiraToken.trim() || undefined,
    }),
    [githubToken, jiraToken]
  );

  const test = useCallback(
    async (kind: ConnectionKind) => {
      if (mountedRef.current) {
        setTesting((current) => ({ ...current, [kind]: true }));
      }
      try {
        const result = await testBfdConnection(kind, {
          config,
          secrets: draftSecrets(),
        });
        if (mountedRef.current) {
          setTestResults((current) => ({ ...current, [kind]: result }));
        }
        return result;
      } catch (error) {
        const result = { ok: false, message: messageOf(error) };
        if (mountedRef.current) {
          setTestResults((current) => ({ ...current, [kind]: result }));
        }
        return result;
      } finally {
        if (mountedRef.current) {
          setTesting((current) => ({ ...current, [kind]: false }));
        }
      }
    },
    [config, draftSecrets]
  );

  const testRef = useRef(test);

  useEffect(() => {
    testRef.current = test;
  }, [test]);

  useEffect(() => {
    const environment = environmentQuery.data;
    if (!environment) {
      return;
    }

    const pending = readyToolAutomaticTests(
      environment.tools,
      configRef.current,
      environment.checkedAt
    ).filter(({ key }) => !autoTestKeysRef.current.has(key));

    if (pending.length === 0) {
      return;
    }

    let cancelled = false;

    async function runPendingAutoTests() {
      for (const item of pending) {
        if (cancelled) {
          return;
        }
        autoTestKeysRef.current.add(item.key);
        await testRef.current(item.kind);
      }
    }

    runPendingAutoTests().catch((error) => {
      if (!cancelled) {
        setSaveResult({ ok: false, message: messageOf(error) });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [environmentQuery.data]);

  function clearTestResults(...kinds: ConnectionKind[]) {
    setTestResults((current) => {
      const next = { ...current };
      for (const kind of kinds) {
        delete next[kind];
      }
      return next;
    });
  }

  function updateConfig(patch: Partial<AppConfig>) {
    setConfig((current) => ({ ...current, ...patch }));
    setSaveResult(null);
    clearTestResults("repo");
  }

  function updateJira(patch: Partial<AppConfig["jira"]>) {
    setConfig((current) => ({
      ...current,
      jira: { ...current.jira, ...patch },
    }));
    setSaveResult(null);
    clearTestResults("jira");
  }

  function updateGithub(patch: Partial<AppConfig["github"]>) {
    setConfig((current) => ({
      ...current,
      github: { ...current.github, ...patch },
    }));
    setSaveResult(null);
    clearTestResults("github", "repo");
  }

  function updateArgo(patch: Partial<AppConfig["argo"]>) {
    setConfig((current) => ({
      ...current,
      argo: { ...current.argo, ...patch },
    }));
    setSaveResult(null);
    clearTestResults("argo");
  }

  function updateGithubToken(value: string) {
    setGithubToken(value);
    setSaveResult(null);
    clearTestResults("github");
  }

  function updateJiraToken(value: string) {
    setJiraToken(value);
    setSaveResult(null);
    clearTestResults("jira");
  }

  async function finish() {
    setSaving(true);
    setSaveResult(null);
    try {
      const saved = await saveBfdConfig({
        config: { ...config, onboardingComplete: true },
        secrets: draftSecrets(),
      });
      setConfig(saved.config);
      setSecrets(saved.secrets);
      setGithubToken("");
      setJiraToken("");
      onComplete();
    } catch (error) {
      setSaveResult({ ok: false, message: messageOf(error) });
    } finally {
      setSaving(false);
    }
  }

  async function skip() {
    setSaving(true);
    setSaveResult(null);
    try {
      await saveBfdConfig({
        config: { ...config, onboardingComplete: true },
        secrets: draftSecrets(),
      });
      onComplete();
    } catch (error) {
      setSaveResult({ ok: false, message: messageOf(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_top_left,var(--muted),transparent_30rem)]">
      <div className="flex w-full flex-1 flex-col p-4 sm:p-6">
        <section className="flex min-h-0 w-full flex-1 flex-col">
          <div className="grid gap-3 border-border border-b pb-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                  <Sparkles className="size-4" />
                </div>
                <div className="grid min-w-0 gap-1">
                  <Badge variant="muted">
                    Screen {step + 1} of {ONBOARDING_SCREENS.length}
                  </Badge>
                  <div className="grid gap-1">
                    <h1 className="font-semibold text-xl tracking-tight">
                      {ONBOARDING_SCREENS[step].title}
                    </h1>
                    <p className="max-w-3xl text-muted-foreground text-xs leading-relaxed">
                      {ONBOARDING_SCREENS[step].description}
                    </p>
                  </div>
                </div>
              </div>

              <Button
                disabled={saving}
                onClick={skip}
                size="sm"
                variant="ghost"
              >
                Skip setup
              </Button>
            </div>

            <div
              aria-label="Onboarding progress"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={progress}
              className="h-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
            >
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto py-5">
            {step === 0 ? (
              <SystemWorkspaceScreen
                config={config}
                environmentError={environmentQuery.error}
                environmentLoading={
                  environmentQuery.isLoading || environmentQuery.isFetching
                }
                missingToolCount={missingToolCount}
                onRefreshEnvironment={() => environmentQuery.refetch()}
                onTest={test}
                onUpdateArgo={updateArgo}
                onUpdateConfig={updateConfig}
                testing={testing}
                testResults={testResults}
                tools={environmentQuery.data?.tools ?? []}
              />
            ) : (
              <AccountsReadyScreen
                config={config}
                githubToken={githubToken}
                jiraToken={jiraToken}
                missingToolCount={missingToolCount}
                onGithubTokenChange={updateGithubToken}
                onJiraTokenChange={updateJiraToken}
                onTest={test}
                onUpdateGithub={updateGithub}
                onUpdateJira={updateJira}
                secrets={secrets}
                testing={testing}
                testResults={testResults}
              />
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-border border-t pt-4">
            <div className="min-h-5 text-xs">
              {saveResult && !saveResult.ok && (
                <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                  <CircleX className="size-3.5" />
                  {saveResult.message}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                disabled={step === 0 || saving}
                onClick={() => setStep((current) => Math.max(0, current - 1))}
                variant="outline"
              >
                <ArrowLeft />
                Back
              </Button>
              {step < ONBOARDING_SCREENS.length - 1 ? (
                <Button
                  disabled={saving}
                  onClick={() =>
                    setStep((current) =>
                      Math.min(ONBOARDING_SCREENS.length - 1, current + 1)
                    )
                  }
                >
                  Continue to accounts
                  <ArrowRight />
                </Button>
              ) : (
                <Button disabled={saving} onClick={finish} size="lg">
                  {saving ? <Loader2 className="animate-spin" /> : <Rocket />}
                  Enter BFD
                </Button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function SystemWorkspaceScreen({
  config,
  environmentError,
  environmentLoading,
  missingToolCount,
  onRefreshEnvironment,
  onTest,
  onUpdateArgo,
  onUpdateConfig,
  testing,
  testResults,
  tools,
}: {
  config: AppConfig;
  environmentError: unknown;
  environmentLoading: boolean;
  missingToolCount: number;
  onRefreshEnvironment: () => void;
  onTest: (kind: ConnectionKind) => Promise<ConnectionResult>;
  onUpdateArgo: (patch: Partial<AppConfig["argo"]>) => void;
  onUpdateConfig: (patch: Partial<AppConfig>) => void;
  testing: TestingState;
  testResults: Partial<Record<ConnectionKind, ConnectionResult>>;
  tools: EnvironmentToolCheck[];
}) {
  return (
    <div className="grid content-start gap-5">
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-background p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Terminal className="size-4" />
          </div>
          <div className="grid gap-1">
            <h2 className="font-semibold text-sm">Automatic local checks</h2>
            <p className="max-w-3xl text-muted-foreground text-xs leading-relaxed">
              Install or authenticate a missing tool, then refresh once. When
              gh, argocd, or kubectl turns green, BFD immediately tests the
              matching live connection and shows the result here.
            </p>
          </div>
        </div>
        <Badge variant={missingToolCount > 0 ? "warning" : "success"}>
          {missingToolCount > 0
            ? `${missingToolCount} tool issue${missingToolCount === 1 ? "" : "s"}`
            : "Tools ready"}
        </Badge>
      </div>

      <ToolsStep
        error={environmentError}
        loading={environmentLoading}
        onRefresh={onRefreshEnvironment}
        tools={tools}
      />

      <WorkspaceStep
        config={config}
        onTest={onTest}
        onUpdateArgo={onUpdateArgo}
        onUpdateConfig={onUpdateConfig}
        testing={testing}
        testResults={testResults}
      />
    </div>
  );
}

function AccountsReadyScreen({
  config,
  githubToken,
  jiraToken,
  missingToolCount,
  onGithubTokenChange,
  onJiraTokenChange,
  onTest,
  onUpdateGithub,
  onUpdateJira,
  secrets,
  testing,
  testResults,
}: {
  config: AppConfig;
  githubToken: string;
  jiraToken: string;
  missingToolCount: number;
  onGithubTokenChange: (value: string) => void;
  onJiraTokenChange: (value: string) => void;
  onTest: (kind: ConnectionKind) => Promise<ConnectionResult>;
  onUpdateGithub: (patch: Partial<AppConfig["github"]>) => void;
  onUpdateJira: (patch: Partial<AppConfig["jira"]>) => void;
  secrets: SecretStatus;
  testing: TestingState;
  testResults: Partial<Record<ConnectionKind, ConnectionResult>>;
}) {
  return (
    <div className="grid content-start gap-5">
      <TokensStep
        config={config}
        githubToken={githubToken}
        jiraToken={jiraToken}
        onGithubTokenChange={onGithubTokenChange}
        onJiraTokenChange={onJiraTokenChange}
        onTest={onTest}
        onUpdateGithub={onUpdateGithub}
        onUpdateJira={onUpdateJira}
        secrets={secrets}
        testing={testing}
        testResults={testResults}
      />

      <FinishStep
        config={config}
        missingToolCount={missingToolCount}
        onTest={onTest}
        testing={testing}
        testResults={testResults}
      />
    </div>
  );
}

function ToolsStep({
  error,
  loading,
  onRefresh,
  tools,
}: {
  error: unknown;
  loading: boolean;
  onRefresh: () => void;
  tools: EnvironmentToolCheck[];
}) {
  const accountTools = tools.filter((tool) => tool.name === "gh");
  const infrastructureTools = tools.filter((tool) => tool.name !== "gh");

  return (
    <div className="grid content-start gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-muted-foreground text-sm leading-relaxed">
          BFD runs these commands from the desktop app. Refresh after installing
          or authenticating a tool; green gh/argocd/kubectl checks trigger their
          connection tests automatically.
        </p>
        <Button disabled={loading} onClick={onRefresh} variant="outline">
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Refresh checks
        </Button>
      </div>

      {Boolean(error) && (
        <Alert variant="warning">
          <AlertDescription>
            Tool checks failed: {messageOf(error)}
          </AlertDescription>
        </Alert>
      )}

      {loading && tools.length === 0 ? (
        <div className="flex min-h-60 items-center justify-center rounded-2xl border border-dashed text-muted-foreground text-sm">
          <Loader2 className="mr-2 size-4 animate-spin" />
          Checking local tools
        </div>
      ) : (
        <div className="grid gap-3">
          {accountTools.map((tool) => (
            <ToolCheckCard key={tool.name} tool={tool} />
          ))}
          {infrastructureTools.length > 0 && (
            <div className="grid items-start gap-3 xl:grid-cols-2">
              {infrastructureTools.map((tool) => (
                <ToolCheckCard key={tool.name} tool={tool} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TokensStep({
  config,
  githubToken,
  jiraToken,
  onGithubTokenChange,
  onJiraTokenChange,
  onTest,
  onUpdateGithub,
  onUpdateJira,
  secrets,
  testing,
  testResults,
}: {
  config: AppConfig;
  githubToken: string;
  jiraToken: string;
  onGithubTokenChange: (value: string) => void;
  onJiraTokenChange: (value: string) => void;
  onTest: (kind: ConnectionKind) => Promise<ConnectionResult>;
  onUpdateGithub: (patch: Partial<AppConfig["github"]>) => void;
  onUpdateJira: (patch: Partial<AppConfig["jira"]>) => void;
  secrets: SecretStatus;
  testing: TestingState;
  testResults: Partial<Record<ConnectionKind, ConnectionResult>>;
}) {
  return (
    <div className="grid content-start items-start gap-4 xl:grid-cols-2">
      <SetupPanel
        action={
          <TestConnectionButton
            kind="jira"
            label="Test Jira"
            onTest={onTest}
            testing={testing}
          />
        }
        icon={<KeyRound className="size-4" />}
        result={testResults.jira}
        resultTestId="connection-result-jira"
        title="Jira"
      >
        <div className="grid gap-4">
          <Field label="Site URL">
            <Input
              onChange={(event) =>
                updateInput(event, (value) => onUpdateJira({ baseUrl: value }))
              }
              value={config.jira.baseUrl}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Project key">
              <Input
                onChange={(event) =>
                  updateInput(event, (value) =>
                    onUpdateJira({ project: value })
                  )
                }
                value={config.jira.project}
              />
            </Field>
            <Field label="Atlassian email">
              <Input
                onChange={(event) =>
                  updateInput(event, (value) => onUpdateJira({ email: value }))
                }
                placeholder="name@bergfreunde.de"
                type="email"
                value={config.jira.email}
              />
            </Field>
          </div>
          <Field
            hint={
              secrets.jiraToken
                ? "Stored token present. Leave empty to keep it."
                : "Create an Atlassian API token and paste it here."
            }
            label="API token"
          >
            <Input
              onChange={(event) => onJiraTokenChange(event.target.value)}
              placeholder="Enter Jira API token"
              type="password"
              value={jiraToken}
            />
          </Field>
          <Button
            className="w-fit"
            onClick={() =>
              openExternalLink(
                "https://id.atlassian.com/manage-profile/security/api-tokens"
              )
            }
            type="button"
            variant="outline"
          >
            <ExternalLink />
            Open Atlassian token page
          </Button>
        </div>
      </SetupPanel>

      <SetupPanel
        action={
          <TestConnectionButton
            kind="github"
            label="Test GitHub"
            onTest={onTest}
            testing={testing}
          />
        }
        icon={<SiGithub className="size-4" />}
        result={testResults.github}
        resultTestId="connection-result-github"
        title="GitHub"
      >
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Owner">
              <Input
                onChange={(event) =>
                  updateInput(event, (value) =>
                    onUpdateGithub({ owner: value })
                  )
                }
                value={config.github.owner}
              />
            </Field>
            <Field label="Repository">
              <Input
                onChange={(event) =>
                  updateInput(event, (value) => onUpdateGithub({ repo: value }))
                }
                value={config.github.repo}
              />
            </Field>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-border px-3 py-2">
            <div className="grid gap-0.5">
              <Label>Reuse local gh CLI token</Label>
              <p className="text-[0.6875rem] text-muted-foreground">
                Recommended if `gh auth status` is already green.
              </p>
            </div>
            <Switch
              checked={config.github.useGhCli}
              onCheckedChange={(useGhCli) => onUpdateGithub({ useGhCli })}
            />
          </div>
          {config.github.useGhCli ? (
            <CommandLine command="gh auth login" label="Authenticate GitHub" />
          ) : (
            <Field
              hint={
                secrets.githubToken
                  ? "Stored token present. Leave empty to keep it."
                  : "Used instead of the gh CLI token."
              }
              label="Personal access token"
            >
              <Input
                onChange={(event) => onGithubTokenChange(event.target.value)}
                placeholder="Enter GitHub token"
                type="password"
                value={githubToken}
              />
            </Field>
          )}
        </div>
      </SetupPanel>
    </div>
  );
}

function WorkspaceStep({
  config,
  onTest,
  onUpdateArgo,
  onUpdateConfig,
  testing,
  testResults,
}: {
  config: AppConfig;
  onTest: (kind: ConnectionKind) => Promise<ConnectionResult>;
  onUpdateArgo: (patch: Partial<AppConfig["argo"]>) => void;
  onUpdateConfig: (patch: Partial<AppConfig>) => void;
  testing: TestingState;
  testResults: Partial<Record<ConnectionKind, ConnectionResult>>;
}) {
  return (
    <div className="grid content-start items-start gap-4 xl:grid-cols-2">
      <SetupPanel
        action={
          <TestConnectionButton
            kind="argo"
            label="Test ArgoCD"
            onTest={onTest}
            testing={testing}
          />
        }
        icon={<Server className="size-4" />}
        result={testResults.argo}
        resultTestId="connection-result-argo"
        title="ArgoCD / Kubernetes"
      >
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="App label">
              <Input
                onChange={(event) =>
                  updateInput(event, (value) => onUpdateArgo({ app: value }))
                }
                value={config.argo.app}
              />
            </Field>
            <Field label="Kube context">
              <Input
                onChange={(event) =>
                  updateInput(event, (value) =>
                    onUpdateArgo({ devContext: value })
                  )
                }
                value={config.argo.devContext}
              />
            </Field>
          </div>
          <CommandLine
            command={`argocd app list --core --kube-context ${config.argo.devContext || "dev"}`}
            label="What BFD runs"
          />
        </div>
      </SetupPanel>

      <SetupPanel
        action={
          <TestConnectionButton
            kind="repo"
            label="Test path"
            onTest={onTest}
            testing={testing}
          />
        }
        icon={<FolderGit2 className="size-4" />}
        result={testResults.repo}
        resultTestId="connection-result-repo"
        title="Devenv path"
      >
        <div className="grid gap-4">
          <Field
            hint="Use the source root, for example ~/devenv/src — not ~/devenv/src/shop."
            label="Devenv source path"
          >
            <Input
              onChange={(event) =>
                updateInput(event, (value) =>
                  onUpdateConfig({ repoPath: value })
                )
              }
              value={config.repoPath}
            />
          </Field>
          <div className="rounded-xl border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-xs leading-relaxed">
            Source root: <span className="font-mono">{config.repoPath}</span>
          </div>
        </div>
      </SetupPanel>
    </div>
  );
}

function FinishStep({
  config,
  missingToolCount,
  onTest,
  testing,
  testResults,
}: {
  config: AppConfig;
  missingToolCount: number;
  onTest: (kind: ConnectionKind) => Promise<ConnectionResult>;
  testing: TestingState;
  testResults: Partial<Record<ConnectionKind, ConnectionResult>>;
}) {
  return (
    <div className="grid content-start gap-4">
      <div className="rounded-2xl border border-border bg-background p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1">
            <h3 className="font-semibold text-lg">Ready check</h3>
            <p className="text-muted-foreground text-sm">
              Automatic checks fill in when their tools are ready. Use these
              buttons for anything you changed manually, then enter BFD.
            </p>
          </div>
          <Badge variant={missingToolCount > 0 ? "warning" : "success"}>
            {missingToolCount > 0
              ? `${missingToolCount} tool warning${missingToolCount === 1 ? "" : "s"}`
              : "Tools ready"}
          </Badge>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <FinalCheckCard
          kind="jira"
          label="Jira"
          onTest={onTest}
          result={testResults.jira}
          testing={testing}
        />
        <FinalCheckCard
          kind="github"
          label={config.github.useGhCli ? "GitHub via gh" : "GitHub token"}
          onTest={onTest}
          result={testResults.github}
          testing={testing}
        />
        <FinalCheckCard
          kind="argo"
          label="ArgoCD / Kubernetes"
          onTest={onTest}
          result={testResults.argo}
          testing={testing}
        />
        <FinalCheckCard
          kind="repo"
          label="Devenv path"
          onTest={onTest}
          result={testResults.repo}
          testing={testing}
        />
      </div>
    </div>
  );
}

function ToolCheckCard({ tool }: { tool: EnvironmentToolCheck }) {
  return (
    <div className="grid content-start gap-3 rounded-2xl border border-border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <StatusIcon status={tool.status} />
          <div className="grid gap-1">
            <h3 className="font-medium text-sm">{tool.label}</h3>
            <p className="text-muted-foreground text-xs">{tool.message}</p>
            {tool.detail && (
              <p className="max-w-xl truncate font-mono text-[0.6875rem] text-muted-foreground">
                {tool.detail}
              </p>
            )}
          </div>
        </div>
        <Badge variant={toolBadgeVariant(tool.status)}>{tool.status}</Badge>
      </div>
      {tool.status === "missing" && (
        <CommandLine command={tool.installCommand} label="Install" />
      )}
      {tool.status === "warning" && tool.authCommand && (
        <CommandLine command={tool.authCommand} label="Fix" />
      )}
      {tool.status === "ok" && (
        <CommandLine command={tool.command} label="Check" />
      )}
    </div>
  );
}

function SetupPanel({
  action,
  children,
  icon,
  result,
  resultTestId,
  title,
}: {
  action: ReactNode;
  children: ReactNode;
  icon: ReactNode;
  result?: ConnectionResult;
  resultTestId?: string;
  title: string;
}) {
  return (
    <div
      className={cn(
        "grid content-start gap-4 self-start rounded-2xl border bg-background p-4",
        setupPanelBorderClass(result)
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            {icon}
          </div>
          <h3 className="font-medium text-sm">{title}</h3>
        </div>
        {action}
      </div>
      {result && <ConnectionResultView result={result} testId={resultTestId} />}
      {children}
    </div>
  );
}

function setupPanelBorderClass(result?: ConnectionResult) {
  if (!result) {
    return "border-border";
  }
  return result.ok ? "border-emerald-500/40" : "border-red-500/40";
}

function Field({
  children,
  hint,
  label,
}: {
  children: ReactNode;
  hint?: ReactNode;
  label: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-[0.6875rem] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function TestConnectionButton({
  kind,
  label,
  onTest,
  testing,
}: {
  kind: ConnectionKind;
  label: string;
  onTest: (kind: ConnectionKind) => Promise<ConnectionResult>;
  testing: TestingState;
}) {
  const isTesting = Boolean(testing[kind]);

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (isTesting) {
      return;
    }

    onTest(kind).catch((error) => {
      console.error(`Failed to test ${kind} connection`, error);
    });
  }

  return (
    <Button
      disabled={isTesting}
      onClick={handleClick}
      size="sm"
      type="button"
      variant="outline"
    >
      {isTesting ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
      {label}
    </Button>
  );
}

function finalCheckCardClass(result?: ConnectionResult) {
  if (!result) {
    return "border-border bg-background";
  }
  return result.ok
    ? "border-emerald-500/40 bg-emerald-500/5"
    : "border-red-500/40 bg-red-500/5";
}

function resultMessageClass(result?: ConnectionResult) {
  if (!result) {
    return "text-muted-foreground";
  }
  return result.ok
    ? "text-emerald-700 dark:text-emerald-300"
    : "text-red-700 dark:text-red-300";
}

function FinalCheckCard({
  kind,
  label,
  onTest,
  result,
  testing,
}: {
  kind: ConnectionKind;
  label: string;
  onTest: (kind: ConnectionKind) => Promise<ConnectionResult>;
  result?: ConnectionResult;
  testing: TestingState;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-2xl border p-4",
        finalCheckCardClass(result)
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {result ? (
          <ResultIcon ok={result.ok} />
        ) : (
          <CircleAlert className="size-5 text-muted-foreground" />
        )}
        <div className="grid min-w-0 gap-1">
          <h3 className="font-medium text-sm">{label}</h3>
          <p className={cn("truncate text-xs", resultMessageClass(result))}>
            {result?.detail ?? result?.message ?? "Not tested yet"}
          </p>
        </div>
      </div>
      <TestConnectionButton
        kind={kind}
        label={`Check ${label}`}
        onTest={onTest}
        testing={testing}
      />
    </div>
  );
}

function ConnectionResultView({
  result,
  testId,
}: {
  result: ConnectionResult;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2 text-xs",
        result.ok
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
      )}
      data-testid={testId}
    >
      <ResultIcon ok={result.ok} />
      <div className="grid gap-0.5">
        <span>{result.message}</span>
        {result.detail && <span className="opacity-80">{result.detail}</span>}
      </div>
    </div>
  );
}

function CommandLine({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="grid gap-1.5">
      <span className="font-medium text-muted-foreground text-xs">{label}</span>
      <div className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-muted/50 p-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">
          {command}
        </code>
        <Button
          onClick={copy}
          size="icon-sm"
          title="Copy command"
          variant="ghost"
        >
          <Clipboard className="size-3" />
          <span className="sr-only">Copy command</span>
        </Button>
      </div>
      {copied && (
        <span className="text-emerald-600 text-xs dark:text-emerald-400">
          Copied
        </span>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: EnvironmentToolStatus }) {
  if (status === "ok") {
    return (
      <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" />
    );
  }
  if (status === "warning") {
    return (
      <CircleAlert className="size-5 text-amber-600 dark:text-amber-400" />
    );
  }
  return <CircleX className="size-5 text-red-600 dark:text-red-400" />;
}

function toolBadgeVariant(status: EnvironmentToolStatus) {
  if (status === "ok") {
    return "success";
  }
  if (status === "warning") {
    return "warning";
  }
  return "danger";
}

function ResultIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
  ) : (
    <CircleX className="size-4 shrink-0 text-red-600 dark:text-red-400" />
  );
}

function updateInput(
  event: ChangeEvent<HTMLInputElement>,
  update: (value: string) => void
) {
  update(event.target.value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
