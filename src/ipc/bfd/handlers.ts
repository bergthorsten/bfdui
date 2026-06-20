import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { os } from "@orpc/server";
import { ArgoService } from "@/services/argo";
import { execCli } from "@/services/cli";
import { ConfigService } from "@/services/config";
import { DeploymentService } from "@/services/deployments";
import { GitHubService } from "@/services/github";
import { JiraCloudService } from "@/services/jira";
import { WorkflowService } from "@/services/workflows";
import type {
  ConnectionResult,
  DeploymentBatch,
  EnvironmentCheckResult,
  EnvironmentToolCheck,
  SaveConfigResult,
} from "@/types/bfd";
import {
  createDeploymentInputSchema,
  deploymentBatchInputSchema,
  getTicketDevelopmentInputSchema,
  recordWorkflowTargetUsageInputSchema,
  saveConfigInputSchema,
  searchTicketsInputSchema,
  testConnectionInputSchema,
} from "./schemas";

const config = new ConfigService();
const argo = new ArgoService(config);
const github = new GitHubService(config);
const jira = new JiraCloudService(config);
const workflows = new WorkflowService(config);
const deployments = new DeploymentService(github, workflows);
const TERMINAL_DEPLOYMENT_STATES = new Set([
  "cancelled",
  "failure",
  "success",
  "timed-out",
]);

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
    const secrets = input.secrets;
    const warnings: string[] = [];

    if (secrets?.clearJiraToken) {
      config.clearSecret("jiraToken");
    } else if (secrets?.jiraToken) {
      trySetSecret("jiraToken", secrets.jiraToken, warnings);
    }

    if (secrets?.clearGithubToken) {
      config.clearSecret("githubToken");
    } else if (secrets?.githubToken) {
      trySetSecret("githubToken", secrets.githubToken, warnings);
    }

    const updated = config.update(input.config);
    return {
      config: updated,
      secrets: config.secretStatus(),
      warning: warnings.length ? warnings.join(" ") : undefined,
    } satisfies SaveConfigResult;
  });

export const testConnection = os
  .input(testConnectionInputSchema)
  .handler(({ input }) => {
    const testConfig = configProviderForTest(input);

    switch (input.kind) {
      case "jira":
        return new JiraCloudService(testConfig).testConnection();
      case "github":
        return new GitHubService(testConfig).testConnection();
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

export const getActiveSprint = os.handler(() => {
  const { sprintJql } = config.get().jira;
  return jira.getActiveSprint(sprintJql);
});

export const searchTickets = os
  .input(searchTicketsInputSchema)
  .handler(({ input }) => jira.searchAccessibleTickets(input.query));

export const getTicketDevelopment = os
  .input(getTicketDevelopmentInputSchema)
  .handler(async ({ input }) => {
    const developmentInfo = await jira.getDevelopmentInfo(input.issueId);
    return github.completeDevelopmentInfo(input.ticketKey, developmentInfo);
  });

export const getDevDeployments = os.handler(() => argo.getDevDeployments());

export const getWorkflowTargets = os.handler(() => workflows.discoverTargets());

export const recordWorkflowTargetUsage = os
  .input(recordWorkflowTargetUsageInputSchema)
  .handler(({ input }) => workflows.recordUsage(input));

export const createDeployment = os
  .input(createDeploymentInputSchema)
  .handler(({ input }) => deployments.createDeployment(input));

export const getDeploymentBatches = os.handler(async () => {
  const batches = deployments.listDeploymentBatches();
  await Promise.all(
    batches
      .filter(isActiveDeploymentBatch)
      .map((batch) =>
        deployments.refreshDeploymentBatch(batch.id).catch(() => batch)
      )
  );
  return deployments.listDeploymentBatches();
});

export const getDeploymentBatch = os
  .input(deploymentBatchInputSchema)
  .handler(({ input }) => deployments.getDeploymentBatch(input.id));

export const refreshDeploymentBatch = os
  .input(deploymentBatchInputSchema)
  .handler(({ input }) => deployments.refreshDeploymentBatch(input.id));

type TestConfigProvider = Pick<ConfigService, "get" | "getSecret">;

function trySetSecret(
  key: "githubToken" | "jiraToken",
  value: string,
  warnings: string[]
): void {
  try {
    config.setSecret(key, value);
  } catch (error) {
    warnings.push(messageOf(error));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isActiveDeploymentBatch(batch: DeploymentBatch): boolean {
  return !TERMINAL_DEPLOYMENT_STATES.has(batch.aggregateState);
}

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
    const { stdout, stderr } = await execCli(command, args, { timeout });
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
