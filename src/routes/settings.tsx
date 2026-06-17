import {
  SiArgo,
  SiArgoHex,
  SiGithub,
  SiGithubHex,
  SiJira,
  SiJiraHex,
} from "@icons-pack/react-simple-icons";
import { createFileRoute } from "@tanstack/react-router";
import { CircleCheck, CircleX, FolderGit2, Loader2, Save } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { getBfdConfig, saveBfdConfig, testBfdConnection } from "@/actions/bfd";
import PageHeader from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { AppConfig, ConnectionResult, SecretStatus } from "@/types/bfd";

type ConnectionKind = "jira" | "github" | "argo" | "repo";
type TestState = "idle" | "testing" | "ok" | "error";

const EMPTY_SECRET_STATUS: SecretStatus = {
  githubToken: false,
  jiraToken: false,
};

function TestButton({
  disabled,
  onTest,
  sectionName,
}: {
  disabled?: boolean;
  onTest: () => Promise<ConnectionResult>;
  sectionName: string;
}) {
  const [state, setState] = useState<TestState>("idle");
  const [result, setResult] = useState<ConnectionResult | null>(null);

  async function run() {
    setState("testing");
    setResult(null);
    const next = await onTest();
    setResult(next);
    setState(next.ok ? "ok" : "error");
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {state === "ok" && result && (
        <span
          aria-live="polite"
          className="flex max-w-80 items-center gap-1 text-emerald-600 text-xs dark:text-emerald-400"
          role="status"
          title={result.detail ?? result.message}
        >
          <CircleCheck className="size-3.5 shrink-0" />
          <span className="truncate">{result.detail ?? result.message}</span>
        </span>
      )}
      {state === "error" && result && (
        <span
          aria-live="polite"
          className="flex max-w-80 items-center gap-1 text-red-600 text-xs dark:text-red-400"
          role="status"
          title={result.message}
        >
          <CircleX className="size-3.5 shrink-0" />
          <span className="truncate">{result.message}</span>
        </span>
      )}
      <Button
        aria-label={`Test ${sectionName} connection`}
        disabled={disabled || state === "testing"}
        onClick={run}
        size="sm"
        variant="outline"
      >
        {state === "testing" && <Loader2 className="animate-spin" />}
        Test connection
      </Button>
    </div>
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-[0.6875rem] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Section({
  icon,
  title,
  description,
  children,
  testButton,
}: {
  children: ReactNode;
  description: string;
  icon: ReactNode;
  testButton: ReactNode;
  title: string;
}) {
  return (
    <section className="shrink-0 rounded-xl border border-border bg-card text-card-foreground shadow-xs">
      <div className="flex flex-col gap-3 border-border border-b px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            {icon}
          </div>
          <div className="grid min-w-0 gap-1">
            <h2 className="font-medium text-sm leading-none">{title}</h2>
            <p className="text-muted-foreground text-xs">{description}</p>
          </div>
        </div>
        {testButton}
      </div>
      <div className="grid gap-4 px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

function Settings() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [secrets, setSecrets] = useState<SecretStatus>(EMPTY_SECRET_STATUS);
  const [jiraToken, setJiraToken] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<ConnectionResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const initial = await getBfdConfig();
        if (!cancelled) {
          setConfig(initial.config);
          setSecrets(initial.secrets);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  function updateConfig(patch: Partial<AppConfig>) {
    setConfig((current) => (current ? { ...current, ...patch } : current));
    setSaveResult(null);
  }

  function updateJira(patch: Partial<AppConfig["jira"]>) {
    setConfig((current) =>
      current ? { ...current, jira: { ...current.jira, ...patch } } : current
    );
    setSaveResult(null);
  }

  function updateGithub(patch: Partial<AppConfig["github"]>) {
    setConfig((current) =>
      current
        ? { ...current, github: { ...current.github, ...patch } }
        : current
    );
    setSaveResult(null);
  }

  function updateArgo(patch: Partial<AppConfig["argo"]>) {
    setConfig((current) =>
      current ? { ...current, argo: { ...current.argo, ...patch } } : current
    );
    setSaveResult(null);
  }

  async function persist(options?: {
    clearGithubToken?: boolean;
    clearJiraToken?: boolean;
    markComplete?: boolean;
  }) {
    if (!config) {
      throw new Error("Settings have not loaded yet.");
    }

    setSaving(true);
    const nextConfig = {
      ...config,
      onboardingComplete: options?.markComplete
        ? true
        : config.onboardingComplete,
    };

    try {
      const saved = await saveBfdConfig({
        config: nextConfig,
        secrets: {
          clearGithubToken: options?.clearGithubToken,
          clearJiraToken: options?.clearJiraToken,
          githubToken: githubToken.trim() || undefined,
          jiraToken: jiraToken.trim() || undefined,
        },
      });
      setConfig(saved.config);
      setSecrets(saved.secrets);
      setGithubToken("");
      setJiraToken("");
      return saved;
    } finally {
      setSaving(false);
    }
  }

  async function saveSettings() {
    try {
      await persist({ markComplete: true });
      setSaveResult({ ok: true, message: "Settings saved." });
    } catch (error) {
      setSaveResult({ ok: false, message: messageOf(error) });
    }
  }

  async function clearSecret(kind: "jira" | "github") {
    await persist({
      clearGithubToken: kind === "github",
      clearJiraToken: kind === "jira",
    });
  }

  async function test(kind: ConnectionKind) {
    await persist();
    return testBfdConnection(kind);
  }

  if (loading || !config) {
    return (
      <>
        <PageHeader
          description="Connect Jira, GitHub and ArgoCD. Secrets are stored encrypted on this device."
          title="Settings"
        />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="size-4 animate-spin" />
            Loading settings
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="Connect Jira, GitHub and ArgoCD. Secrets are stored encrypted on this device."
        title="Settings"
      />
      <div className="flex min-h-0 flex-1 items-start overflow-auto">
        <div className="mx-auto flex w-full min-w-[48rem] max-w-5xl shrink-0 flex-col gap-4 p-4 pb-24 sm:gap-5 sm:p-6 sm:pb-24">
          <Section
            description="Jira Cloud - REST API v3"
            icon={<SiJira className="size-4" color={SiJiraHex} />}
            testButton={
              <TestButton
                disabled={saving}
                onTest={() => test("jira")}
                sectionName="Jira"
              />
            }
            title="Jira"
          >
            <Field label="Site URL">
              <Input
                onChange={(event) =>
                  updateJira({ baseUrl: event.target.value })
                }
                value={config.jira.baseUrl}
              />
            </Field>
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Project key">
                <Input
                  onChange={(event) =>
                    updateJira({ project: event.target.value })
                  }
                  value={config.jira.project}
                />
              </Field>
              <Field label="Atlassian email">
                <Input
                  onChange={(event) =>
                    updateJira({ email: event.target.value })
                  }
                  placeholder="name@bergfreunde.de"
                  type="email"
                  value={config.jira.email}
                />
              </Field>
              <Field
                hint={
                  secrets.jiraToken
                    ? "Stored token is present. Leave empty to keep it."
                    : "Atlassian API token (Basic auth)."
                }
                label="API token"
              >
                <div className="flex gap-2">
                  <Input
                    onChange={(event) => setJiraToken(event.target.value)}
                    placeholder="Enter new token"
                    type="password"
                    value={jiraToken}
                  />
                  {secrets.jiraToken && (
                    <Button
                      disabled={saving}
                      onClick={() => clearSecret("jira")}
                      size="sm"
                      variant="outline"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </Field>
            </div>
            <Field
              hint="Editable JQL used to load the sprint board."
              label="Sprint JQL"
            >
              <Input
                onChange={(event) =>
                  updateJira({ sprintJql: event.target.value })
                }
                value={config.jira.sprintJql}
              />
            </Field>
          </Section>

          <Section
            description="Pull requests, branches and workflow dispatch"
            icon={<SiGithub className="size-4" color={SiGithubHex} />}
            testButton={
              <TestButton
                disabled={saving}
                onTest={() => test("github")}
                sectionName="GitHub"
              />
            }
            title="GitHub"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Owner">
                <Input
                  onChange={(event) =>
                    updateGithub({ owner: event.target.value })
                  }
                  value={config.github.owner}
                />
              </Field>
              <Field label="Repository">
                <Input
                  onChange={(event) =>
                    updateGithub({ repo: event.target.value })
                  }
                  value={config.github.repo}
                />
              </Field>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <div className="grid gap-0.5">
                <Label>Reuse local gh CLI token</Label>
                <p className="text-[0.6875rem] text-muted-foreground">
                  Use the token from your authenticated gh CLI.
                </p>
              </div>
              <Switch
                checked={config.github.useGhCli}
                onCheckedChange={(useGhCli) => updateGithub({ useGhCli })}
              />
            </div>
            {!config.github.useGhCli && (
              <Field
                hint={
                  secrets.githubToken
                    ? "Stored token is present. Leave empty to keep it."
                    : "Used instead of the gh CLI token."
                }
                label="Personal Access Token"
              >
                <div className="flex gap-2">
                  <Input
                    onChange={(event) => setGithubToken(event.target.value)}
                    placeholder="Enter new token"
                    type="password"
                    value={githubToken}
                  />
                  {secrets.githubToken && (
                    <Button
                      disabled={saving}
                      onClick={() => clearSecret("github")}
                      size="sm"
                      variant="outline"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </Field>
            )}
          </Section>

          <Section
            description="Dev system state via the argocd CLI (core mode)"
            icon={<SiArgo className="size-4" color={SiArgoHex} />}
            testButton={
              <TestButton
                disabled={saving}
                onTest={() => test("argo")}
                sectionName="ArgoCD / Kubernetes"
              />
            }
            title="ArgoCD / Kubernetes"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="App label">
                <Input
                  onChange={(event) => updateArgo({ app: event.target.value })}
                  value={config.argo.app}
                />
              </Field>
              <Field label="Kube context">
                <Input
                  onChange={(event) =>
                    updateArgo({ devContext: event.target.value })
                  }
                  value={config.argo.devContext}
                />
              </Field>
            </div>
          </Section>

          <Section
            description="Used later for affected-workflow detection"
            icon={<FolderGit2 className="size-4 text-muted-foreground" />}
            testButton={
              <TestButton
                disabled={saving}
                onTest={() => test("repo")}
                sectionName="Local shop checkout"
              />
            }
            title="Local shop checkout"
          >
            <Field label="Repository path">
              <Input
                onChange={(event) =>
                  updateConfig({ repoPath: event.target.value })
                }
                value={config.repoPath}
              />
            </Field>
          </Section>

          <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-between gap-3 border-border border-t bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
            <div className="min-h-5 text-xs">
              {saveResult?.ok && (
                <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <CircleCheck className="size-3.5" />
                  {saveResult.message}
                </span>
              )}
              {saveResult && !saveResult.ok && (
                <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                  <CircleX className="size-3.5" />
                  {saveResult.message}
                </span>
              )}
            </div>
            <Button disabled={saving} onClick={saveSettings} size="lg">
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              Save settings
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const Route = createFileRoute("/settings")({
  component: Settings,
});
