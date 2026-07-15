import { isDefaultBranch, isReservedEnvironment } from "@/domain/environments";
import { execCli } from "@/services/cli";
import type { ConfigService } from "@/services/config";
import type {
  ArgoAutoSync,
  ArgoAutoSyncUpdateResult,
  ConnectionResult,
  DevDeployment,
} from "@/types/bfd";

const TICKET_KEY_PREFIX_PATTERN = /^([A-Z]+-[0-9]+)-/;
const ARGO_APPLICATION_RESOURCE = "applications.argoproj.io";
const DEFAULT_ARGOCD_NAMESPACE = "argocd";

interface ArgoQuerySettings {
  app: string;
  context: string;
  namespace: string;
}

interface KubernetesList<T> {
  items?: T[];
}

interface ArgoFailure {
  detail?: string;
  message: string;
}

class ArgoServiceError extends Error {
  readonly detail?: string;

  constructor({ detail, message }: ArgoFailure) {
    super(message);
    this.name = "ArgoServiceError";
    this.detail = detail;
  }
}

interface ArgoApplication {
  metadata?: {
    labels?: Record<string, string | undefined>;
    name?: string;
  };
  spec?: {
    destination?: {
      namespace?: string;
    };
    source?: {
      targetRevision?: string;
    };
    syncPolicy?: {
      automated?: false | { prune?: boolean };
    };
  };
  status?: {
    health?: {
      status?: string;
    };
    history?: Array<{
      deployedAt?: string;
    }>;
    sync?: {
      revision?: string;
      status?: string;
    };
  };
}

export class ArgoService {
  private readonly config: Pick<ConfigService, "get">;

  constructor(config: Pick<ConfigService, "get">) {
    this.config = config;
  }

  async testConnection(): Promise<ConnectionResult> {
    try {
      const apps = await this.fetchApplications();
      const settings = this.querySettings();
      return {
        ok: true,
        message: "Connected to ArgoCD.",
        detail: `${apps.length} Application${apps.length === 1 ? "" : "s"} in namespace ${settings.namespace} for app=${settings.app}`,
      };
    } catch (error) {
      return failureResult(error);
    }
  }

  async getDevDeployments(): Promise<DevDeployment[]> {
    const apps = await this.fetchApplications();
    return parseArgoApplications(apps, this.config.get().argo.app);
  }

  async setDevAutoSync(
    environment: string,
    enabled: boolean
  ): Promise<ArgoAutoSyncUpdateResult> {
    const app = this.config.get().argo.app.trim() || "shop";
    const autoSync = enabled ? "on" : "off";
    const args = [
      "argo",
      "--auto-sync",
      autoSync,
      "-e",
      environment,
      "--deployment",
      app,
    ];

    try {
      const { stderr, stdout } = await execCli("bfd", args, {
        timeout: 60_000,
      });
      return {
        autoSync,
        environment,
        message: `Auto sync ${enabled ? "enabled" : "disabled"} for dev-${environment}.`,
        output: firstMeaningfulLine(stdout || stderr),
      };
    } catch (error) {
      throw new ArgoServiceError({
        detail: developerHintForBfd(args, outputOf(error) ?? undefined),
        message: `Could not ${enabled ? "enable" : "disable"} auto sync for dev-${environment}: ${messageOf(error)}`,
      });
    }
  }

  private async fetchApplications(): Promise<unknown[]> {
    const settings = this.querySettings();
    const args = kubectlApplicationArgs(settings);

    try {
      const { stdout } = await execCli("kubectl", args, { timeout: 20_000 });
      const parsed = JSON.parse(stdout) as KubernetesList<unknown>;
      if (!Array.isArray(parsed.items)) {
        throw new ArgoServiceError({
          detail: developerHint(settings, args),
          message:
            "Kubernetes returned an unexpected ArgoCD Application list shape.",
        });
      }
      return parsed.items;
    } catch (error) {
      if (error instanceof ArgoServiceError) {
        throw error;
      }
      if (error instanceof SyntaxError) {
        throw new ArgoServiceError({
          detail: developerHint(settings, args),
          message: "Kubernetes returned invalid JSON for ArgoCD Applications.",
        });
      }
      throw new ArgoServiceError(argoFailure(error, settings, args));
    }
  }

  private querySettings(): ArgoQuerySettings {
    const { argo } = this.config.get();
    return {
      app: argo.app.trim(),
      context: argo.devContext.trim(),
      namespace: argo.argocdNamespace?.trim() || DEFAULT_ARGOCD_NAMESPACE,
    };
  }
}

export function parseArgoApplications(
  apps: unknown[],
  fallbackApp: string,
  now = new Date()
): DevDeployment[] {
  return apps.flatMap((app) => {
    const parsed = app as ArgoApplication;
    const environment = parsed.spec?.destination?.namespace;
    if (!environment) {
      return [];
    }

    const branch = branchOf(parsed);
    const deployedAt = latestDeployedAt(parsed);
    const reserved = isReservedEnvironment(environment);
    const isDefault = isDefaultBranch(branch);

    return [
      {
        ageSeconds: ageSeconds(deployedAt, now),
        app: parsed.metadata?.labels?.app ?? fallbackApp,
        autoSync: autoSyncOf(parsed),
        branch,
        deployedAt,
        deployedRevision: deployedRevisionOf(parsed),
        environment,
        health: parsed.status?.health?.status ?? "Unknown",
        isFree: isDefault && !reserved,
        reserved,
        sync: parsed.status?.sync?.status ?? "Unknown",
        ticketKey: ticketKeyFromBranch(branch),
      },
    ];
  });
}

function branchOf(app: ArgoApplication): string | null {
  return (
    app.metadata?.labels?.branch ?? app.spec?.source?.targetRevision ?? null
  );
}

function latestDeployedAt(app: ArgoApplication): string | null {
  const history = app.status?.history ?? [];
  const latest = history.at(-1)?.deployedAt;
  return latest ? latest.replace(/^'+|'+$/g, "") : null;
}

function deployedRevisionOf(app: ArgoApplication): string | null {
  return app.status?.sync?.revision ?? null;
}

function ageSeconds(deployedAt: string | null, now: Date): number | null {
  if (!deployedAt) {
    return null;
  }
  const timestamp = Date.parse(deployedAt);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
}

function autoSyncOf(app: ArgoApplication): ArgoAutoSync {
  const automated = app.spec?.syncPolicy?.automated;
  if (!automated) {
    return "off";
  }
  return automated.prune ? "on" : "No prune";
}

export function ticketKeyFromBranch(branch: string | null): string | null {
  if (!branch) {
    return null;
  }
  const match = branch.match(TICKET_KEY_PREFIX_PATTERN);
  return match ? match[1] : null;
}

function kubectlApplicationArgs(settings: ArgoQuerySettings): string[] {
  const args: string[] = [];
  if (settings.context) {
    args.push("--context", settings.context);
  }
  return [
    ...args,
    "-n",
    settings.namespace,
    "get",
    ARGO_APPLICATION_RESOURCE,
    "-l",
    `app=${settings.app}`,
    "-o",
    "json",
  ];
}

function failureResult(error: unknown): ConnectionResult {
  if (error instanceof ArgoServiceError) {
    return { detail: error.detail, message: error.message, ok: false };
  }
  return { ok: false, message: messageOf(error) };
}

function argoFailure(
  error: unknown,
  settings: ArgoQuerySettings,
  args: string[]
): ArgoFailure {
  const output = outputOf(error) ?? "";
  const detail = developerHint(settings, args, output);
  const code = (error as { code?: unknown }).code;
  const text = output.toLowerCase();

  if (code === "ENOENT") {
    return {
      detail,
      message: "kubectl is not installed or is not available to BFD.",
    };
  }

  if (text.includes("context") && text.includes("does not exist")) {
    return {
      detail,
      message: `Kubernetes context "${settings.context}" was not found.`,
    };
  }

  if (text.includes("namespaces") && text.includes("not found")) {
    return {
      detail,
      message: `ArgoCD namespace "${settings.namespace}" was not found in Kubernetes.`,
    };
  }

  if (
    text.includes("no matches for kind") ||
    text.includes("the server doesn't have a resource type") ||
    text.includes("the server could not find the requested resource")
  ) {
    return {
      detail,
      message:
        "The ArgoCD Application CRD is not available in this Kubernetes context.",
    };
  }

  if (text.includes("forbidden") || text.includes("cannot list resource")) {
    return {
      detail,
      message: `Kubernetes access is missing: this user cannot list ArgoCD Applications in namespace "${settings.namespace}".`,
    };
  }

  if (
    text.includes("you must be logged in") ||
    text.includes(
      "the server has asked for the client to provide credentials"
    ) ||
    text.includes("unable to connect") ||
    text.includes("i/o timeout")
  ) {
    return {
      detail,
      message: `Kubernetes authentication or connectivity is not ready for context "${settings.context || "current"}".`,
    };
  }

  return {
    detail,
    message: output || messageOf(error),
  };
}

function developerHint(
  settings: ArgoQuerySettings,
  args: string[],
  output?: string
): string {
  const authArgs = settings.context ? `--context ${settings.context} ` : "";
  const hints = [
    `Command: kubectl ${args.join(" ")}`,
    `RBAC check: kubectl ${authArgs}auth can-i list ${ARGO_APPLICATION_RESOURCE} -n ${settings.namespace}`,
  ];
  if (output) {
    hints.push(`Output: ${firstMeaningfulLine(output)}`);
  }
  return hints.join(" | ");
}

function developerHintForBfd(args: string[], output?: string): string {
  const hints = [`Command: bfd ${args.join(" ")}`];
  if (output) {
    hints.push(`Output: ${firstMeaningfulLine(output)}`);
  }
  return hints.join("\n");
}

function outputOf(error: unknown): string | null {
  const candidate = error as { stderr?: unknown; stdout?: unknown };
  return (
    [candidate.stderr, candidate.stdout]
      .filter(
        (value): value is string =>
          typeof value === "string" && Boolean(value.trim())
      )
      .map((value) => value.trim())
      .join("\n") || null
  );
}

function messageOf(error: unknown): string {
  const output = outputOf(error);
  if (output) {
    return output;
  }
  return error instanceof Error ? error.message : String(error);
}

function firstMeaningfulLine(value: string): string {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? value.trim()
  );
}
