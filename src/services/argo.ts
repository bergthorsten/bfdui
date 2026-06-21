import { isDefaultBranch, isReservedEnvironment } from "@/domain/environments";
import { execCli } from "@/services/cli";
import type { ConfigService } from "@/services/config";
import type {
  ArgoAutoSync,
  ConnectionResult,
  DevDeployment,
} from "@/types/bfd";

const TICKET_KEY_PREFIX_PATTERN = /^([A-Z]+-[0-9]+)-/;

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
      const { app } = this.config.get().argo;
      return {
        ok: true,
        message: "Connected to ArgoCD.",
        detail: `${apps.length} app${apps.length === 1 ? "" : "s"} for app=${app}`,
      };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }

  async getDevDeployments(): Promise<DevDeployment[]> {
    const apps = await this.fetchApplications();
    return parseArgoApplications(apps, this.config.get().argo.app);
  }

  private async fetchApplications(): Promise<unknown[]> {
    const { argo } = this.config.get();
    const args = [
      "app",
      "list",
      "-l",
      `app=${argo.app}`,
      "-o",
      "json",
      "--core",
    ];

    if (argo.devContext) {
      args.push("--kube-context", argo.devContext);
    }

    const { stdout } = await execCli("argocd", args, { timeout: 20_000 });
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("ArgoCD returned an unexpected response shape.");
    }
    return parsed;
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

function messageOf(error: unknown): string {
  const output = outputOf(error);
  if (output) {
    return output;
  }
  return error instanceof Error ? error.message : String(error);
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
