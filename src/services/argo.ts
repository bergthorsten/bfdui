import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConfigService } from "@/services/config";
import type {
  ArgoAutoSync,
  ConnectionResult,
  DevDeployment,
} from "@/types/bfd";

const execFileAsync = promisify(execFile);

const RESERVED_ENVIRONMENTS = new Set(["20", "epm", "oms", "sap"]);
const DEFAULT_BRANCHES = new Set(["master", "main"]);
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
      status?: string;
    };
  };
}

export class ArgoService {
  private readonly config: ConfigService;

  constructor(config: ConfigService) {
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

    const { stdout } = await execFileAsync("argocd", args, { timeout: 20_000 });
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
    const reserved = RESERVED_ENVIRONMENTS.has(environment);
    const isDefault = branch ? DEFAULT_BRANCHES.has(branch) : true;

    return [
      {
        ageSeconds: ageSeconds(deployedAt, now),
        app: parsed.metadata?.labels?.app ?? fallbackApp,
        autoSync: autoSyncOf(parsed),
        branch,
        deployedAt,
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
  return error instanceof Error ? error.message : String(error);
}
