import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { os } from "@orpc/server";
import { ArgoService } from "@/services/argo";
import { ConfigService } from "@/services/config";
import { JiraCloudService } from "@/services/jira";
import type {
  ConnectionResult,
  EnvironmentCheckResult,
  EnvironmentToolCheck,
} from "@/types/bfd";
import {
  getTicketDevelopmentInputSchema,
  saveConfigInputSchema,
  searchTicketsInputSchema,
  testConnectionInputSchema,
} from "./schemas";

const execFileAsync = promisify(execFile);
const config = new ConfigService();
const argo = new ArgoService(config);
const jira = new JiraCloudService(config);

export const getConfig = os.handler(() => ({
  config: config.get(),
  secrets: config.secretStatus(),
}));

export const checkEnvironment = os.handler(async () => {
  const tools = await Promise.all([
    checkGhCli(),
    checkArgocdCli(),
    checkKubectlCli(),
  ]);

  return {
    checkedAt: Date.now(),
    tools,
  } satisfies EnvironmentCheckResult;
});

export const saveConfig = os
  .input(saveConfigInputSchema)
  .handler(({ input }) => {
    const updated = config.update(input.config);
    const secrets = input.secrets;

    if (secrets?.clearJiraToken) {
      config.clearSecret("jiraToken");
    } else if (secrets?.jiraToken) {
      config.setSecret("jiraToken", secrets.jiraToken);
    }

    if (secrets?.clearGithubToken) {
      config.clearSecret("githubToken");
    } else if (secrets?.githubToken) {
      config.setSecret("githubToken", secrets.githubToken);
    }

    return { config: updated, secrets: config.secretStatus() };
  });

export const testConnection = os
  .input(testConnectionInputSchema)
  .handler(({ input }) => {
    const testConfig = configProviderForTest(input);

    switch (input.kind) {
      case "jira":
        return new JiraCloudService(testConfig).testConnection();
      case "github":
        return testGithubConnection(testConfig);
      case "argo":
        return new ArgoService(testConfig).testConnection();
      case "repo":
        return testRepoConnection(testConfig);
      default:
        return { ok: false, message: "Unknown connection type." };
    }
  });

export const getSprintTickets = os.handler(() => {
  const { sprintJql } = config.get().jira;
  return jira.search(sprintJql);
});

export const searchTickets = os
  .input(searchTicketsInputSchema)
  .handler(({ input }) => jira.searchAccessibleTickets(input.query));

export const getTicketDevelopment = os
  .input(getTicketDevelopmentInputSchema)
  .handler(({ input }) => jira.getDevelopmentInfo(input.issueId));

export const getDevDeployments = os.handler(() => argo.getDevDeployments());

type TestConfigProvider = Pick<ConfigService, "get" | "getSecret">;

function configProviderForTest(input: {
  config?: ReturnType<ConfigService["get"]>;
  secrets?: { githubToken?: string; jiraToken?: string };
}): TestConfigProvider {
  if (!input.config) {
    return config;
  }

  const secrets = input.secrets ?? {};
  return {
    get: () => input.config as ReturnType<ConfigService["get"]>,
    getSecret: (key) => {
      if (key === "githubToken" && secrets.githubToken) {
        return secrets.githubToken;
      }
      if (key === "jiraToken" && secrets.jiraToken) {
        return secrets.jiraToken;
      }
      return config.getSecret(key);
    },
  };
}

async function testGithubConnection(
  testConfig: TestConfigProvider = config
): Promise<ConnectionResult> {
  const { github } = testConfig.get();

  try {
    const token = github.useGhCli
      ? await githubCliToken()
      : testConfig.getSecret("githubToken");
    if (!token) {
      return {
        ok: false,
        message: github.useGhCli
          ? "No GitHub token found via gh CLI."
          : "No GitHub token configured.",
      };
    }

    const res = await fetch(
      `https://api.github.com/repos/${github.owner}/${github.repo}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "GitHub authentication failed." };
    }
    if (res.status === 404) {
      return { ok: false, message: "GitHub repository was not found." };
    }
    if (!res.ok) {
      return { ok: false, message: `GitHub returned HTTP ${res.status}.` };
    }

    const repo = (await res.json()) as {
      default_branch?: string;
      full_name?: string;
    };
    return {
      ok: true,
      message: "Connected to GitHub.",
      detail: `${repo.full_name ?? `${github.owner}/${github.repo}`} · ${repo.default_branch ?? "default branch unknown"}`,
    };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

async function githubCliToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      timeout: 5000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function checkGhCli(): Promise<EnvironmentToolCheck> {
  const version = await runCli("gh", ["--version"], 3000);
  const base = {
    authCommand: "gh auth login",
    command: "gh auth status",
    installCommand: installCommandFor("gh"),
    label: "GitHub CLI",
    name: "gh" as const,
  };

  if (version.missing) {
    return {
      ...base,
      message: "gh is not installed.",
      status: "missing",
    };
  }

  const auth = await runCli("gh", ["auth", "status"], 5000);
  if (!auth.ok) {
    return {
      ...base,
      detail: firstLine(auth.output) ?? firstLine(version.output),
      message: "Installed, but GitHub authentication is not ready.",
      status: "warning",
    };
  }

  return {
    ...base,
    detail: firstLine(auth.output) ?? firstLine(version.output),
    message: "Installed and authenticated.",
    status: "ok",
  };
}

async function checkArgocdCli(): Promise<EnvironmentToolCheck> {
  const version = await runCli("argocd", ["version", "--client"], 5000);
  const base = {
    authCommand: "argocd app list --core --kube-context dev",
    command: "argocd version --client",
    installCommand: installCommandFor("argocd"),
    label: "ArgoCD CLI",
    name: "argocd" as const,
  };

  if (version.missing) {
    return {
      ...base,
      message: "argocd is not installed.",
      status: "missing",
    };
  }

  if (!version.ok) {
    return {
      ...base,
      detail: firstLine(version.output),
      message: "Installed, but the client check returned a warning.",
      status: "warning",
    };
  }

  return {
    ...base,
    detail: firstLine(version.output),
    message: "Installed. BFD uses ArgoCD core mode.",
    status: "ok",
  };
}

async function checkKubectlCli(): Promise<EnvironmentToolCheck> {
  const version = await runCli("kubectl", ["version", "--client"], 5000);
  const base = {
    authCommand: "kubectl config get-contexts",
    command: "kubectl config current-context",
    installCommand: installCommandFor("kubectl"),
    label: "Kubernetes CLI",
    name: "kubectl" as const,
  };

  if (version.missing) {
    return {
      ...base,
      message: "kubectl is not installed.",
      status: "missing",
    };
  }

  const context = await runCli("kubectl", ["config", "current-context"], 5000);
  if (!context.ok) {
    return {
      ...base,
      detail: firstLine(context.output) ?? firstLine(version.output),
      message: "Installed, but no current Kubernetes context is selected.",
      status: "warning",
    };
  }

  return {
    ...base,
    detail: `Current context: ${context.output.trim()}`,
    message: "Installed and a context is selected.",
    status: "ok",
  };
}

async function runCli(
  command: string,
  args: string[],
  timeout: number
): Promise<{ missing: boolean; ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout });
    return { missing: false, ok: true, output: combineOutput(stdout, stderr) };
  } catch (error) {
    const candidate = error as {
      code?: unknown;
      stderr?: unknown;
      stdout?: unknown;
    };
    return {
      missing: candidate.code === "ENOENT",
      ok: false,
      output: combineOutput(candidate.stdout, candidate.stderr),
    };
  }
}

function combineOutput(stdout: unknown, stderr: unknown): string {
  return [stdout, stderr]
    .filter(
      (value): value is string =>
        typeof value === "string" && Boolean(value.trim())
    )
    .map((value) => value.trim())
    .join("\n");
}

function firstLine(value: string): string | undefined {
  return value
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

function installCommandFor(command: "argocd" | "gh" | "kubectl"): string {
  if (process.platform === "darwin") {
    return macInstallCommandFor(command);
  }
  if (process.platform === "linux") {
    return linuxInstallCommandFor(command);
  }
  if (process.platform === "win32") {
    return windowsInstallCommandFor(command);
  }
  return `Install ${command} for your operating system, then refresh checks.`;
}

function macInstallCommandFor(command: "argocd" | "gh" | "kubectl"): string {
  if (command === "kubectl") {
    return "brew install kubernetes-cli";
  }
  return `brew install ${command}`;
}

function linuxInstallCommandFor(command: "argocd" | "gh" | "kubectl"): string {
  switch (command) {
    case "argocd":
      return "curl -sSL -o /tmp/argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64 && sudo install -m 555 /tmp/argocd /usr/local/bin/argocd";
    case "gh":
      return "sudo apt update && sudo apt install gh";
    case "kubectl":
      return "curl -LO https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl && sudo install -m 755 kubectl /usr/local/bin/kubectl";
    default:
      return `Install ${command} with your Linux package manager.`;
  }
}

function windowsInstallCommandFor(
  command: "argocd" | "gh" | "kubectl"
): string {
  switch (command) {
    case "argocd":
      return "winget install ArgoProject.ArgoCD";
    case "gh":
      return "winget install GitHub.cli";
    case "kubectl":
      return "winget install Kubernetes.kubectl";
    default:
      return `Install ${command} with your Windows package manager.`;
  }
}

function testRepoConnection(
  testConfig: Pick<ConfigService, "get"> = config
): ConnectionResult {
  const repoPath = expandHome(testConfig.get().repoPath);
  const configuredRepoPath = path.join(repoPath, ".github", "workflows");
  const repoNamedCheckoutPath = path.join(
    repoPath,
    testConfig.get().github.repo,
    ".github",
    "workflows"
  );

  if (!existsSync(repoPath)) {
    return { ok: false, message: "Devenv path does not exist." };
  }

  if (!statSync(repoPath).isDirectory()) {
    return { ok: false, message: "Devenv path is not a directory." };
  }

  if (
    existsSync(configuredRepoPath) &&
    statSync(configuredRepoPath).isDirectory()
  ) {
    return {
      ok: true,
      message: "Local checkout found.",
      detail: configuredRepoPath,
    };
  }

  if (
    existsSync(repoNamedCheckoutPath) &&
    statSync(repoNamedCheckoutPath).isDirectory()
  ) {
    return {
      ok: true,
      message: "Local checkout found inside devenv path.",
      detail: repoNamedCheckoutPath,
    };
  }

  if (repoPath.endsWith(path.sep + testConfig.get().github.repo)) {
    return {
      ok: false,
      message: "No .github/workflows directory found in this checkout.",
    };
  }

  return {
    ok: false,
    message: `No ${testConfig.get().github.repo}/.github/workflows directory found inside this devenv path.`,
  };
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
