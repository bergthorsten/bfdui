/**
 * Core BFD domain types shared between the Electron main process (services)
 * and the renderer (dashboard). Grounded in the real `bf-deploy` data shapes:
 * ArgoCD Application JSON, Jira Cloud REST v3, and the GitHub REST API.
 */

/** Bucketed Jira status, derived from bf-deploy constants. */
export type JiraStatusCategory =
  | "free"
  | "occupied"
  | "backlog"
  | "reserved"
  | "na";

export type ArgoSync = "Synced" | "OutOfSync" | "Unknown" | string;
export type ArgoHealth =
  | "Healthy"
  | "Progressing"
  | "Degraded"
  | "Missing"
  | "Suspended"
  | "Unknown"
  | string;
export type ArgoAutoSync = "on" | "No prune" | "off";

/** A single dev system's state, parsed from an ArgoCD Application. */
export interface DevDeployment {
  /** Seconds since deployedAt, computed at fetch time. */
  ageSeconds: number | null;
  /** ArgoCD app name, e.g. "shop". */
  app: string;
  autoSync: ArgoAutoSync;
  branch: string | null;
  /** ISO timestamp of the latest deploy, from status.history[-1].deployedAt. */
  deployedAt: string | null;
  /** Git revision reported by ArgoCD for the currently synced application. */
  deployedRevision?: string | null;
  /** Destination namespace == dev system, e.g. "04", "oms". */
  environment: string;
  health: ArgoHealth;
  /** True when nothing meaningful (default branch) is deployed. */
  isFree: boolean;
  /** Reserved systems (oms/epm/sap/20) are not freely usable. */
  reserved: boolean;
  sync: ArgoSync;
  ticketKey: string | null;
}

export interface JiraTicket {
  assignee: string | null;
  assigneeAvatar: string | null;
  /** Numeric Jira issue ID, needed for Jira development-panel APIs. */
  id: string;
  key: string;
  status: string;
  statusCategory: JiraStatusCategory;
  title: string;
  updated: string | null;
  url: string;
}

export interface JiraSprint {
  endDate: string | null;
  goal: string;
  id: number;
  name: string;
  startDate: string | null;
  state: string;
}

export interface PullRequestSummary {
  approved?: boolean;
  baseRef: string;
  changedFiles?: string[];
  headRef: string;
  headSha: string | null;
  isDraft: boolean;
  mergedAt?: string | null;
  number: number;
  source: DevelopmentDataSource;
  state: "open" | "closed" | "merged";
  title: string;
  updatedAt?: string | null;
  url: string;
}

export interface BranchSummary {
  headSha: string;
  name: string;
  source: DevelopmentDataSource;
  url: string;
}

export type DevelopmentDataSource = "enriched" | "github" | "jira";

export interface BuildSummary {
  name: string;
  status: string;
  url: string;
}

export interface JiraDevelopmentInfo {
  branches: BranchSummary[];
  buildCount: number;
  builds: BuildSummary[];
  errors: string[];
  pullRequests: PullRequestSummary[];
}

export interface WorkflowTargetUsage {
  lastBranch?: string;
  lastEnvironment?: string;
  lastTicketKey?: string;
  lastUsedAt: number;
  usageCount: number;
}

export type WorkflowInputType =
  | "boolean"
  | "choice"
  | "environment"
  | "number"
  | "string";

export interface WorkflowInputDefinition {
  default?: string;
  description?: string;
  name: string;
  options: string[];
  required: boolean;
  type: WorkflowInputType;
}

export interface WorkflowTarget {
  affectedPathGlobs: string[];
  aliases: string[];
  fileName: string;
  group: string;
  inputs: WorkflowInputDefinition[];
  name: string;
  path: string;
  usage: WorkflowTargetUsage | null;
}

export interface WorkflowTargetDiscoveryResult {
  repoPath: string;
  targets: WorkflowTarget[];
  warnings: string[];
  workflowsPath: string | null;
}

export interface WorkflowTargetUsageInput {
  branch?: string;
  environment?: string;
  name: string;
  ticketKey?: string;
}

export type DeploymentRunState =
  | "cancelled"
  | "failure"
  | "in-progress"
  | "pending-dispatch"
  | "queued"
  | "success"
  | "timed-out"
  | "unknown";

export interface DeploymentWorkflowInput {
  inputs: Record<string, string>;
  name: string;
  path?: string;
}

export interface DeploymentIntentInput {
  branch: string;
  environment: string;
  sourceCommitSha?: string;
  ticketKey?: string;
  workflows: DeploymentWorkflowInput[];
}

export interface DeploymentWorkflowRun {
  conclusion?: string | null;
  currentAttempt?: number;
  dispatchError?: string;
  dispatchRequestedAt: number;
  environment: string;
  fileName: string;
  inputs: Record<string, string>;
  runCreatedAt?: string;
  runId?: number;
  runStatus?: string | null;
  runUpdatedAt?: string;
  runUrl?: string;
  state: DeploymentRunState;
  targetName: string;
  workflowPath: string;
}

export interface DeploymentBatch {
  aggregateState: DeploymentRunState;
  branch: string;
  createdAt: number;
  environment: string;
  id: string;
  sourceCommitSha?: string;
  ticketKey?: string;
  updatedAt: number;
  workflows: DeploymentWorkflowRun[];
}

/** Joined row for the ticket-centric dashboard. */
export interface TicketDeploymentRow {
  branches: BranchSummary[];
  deployments: DevDeployment[];
  developmentStatus?: IntegrationStatus;
  devSystemStatus?: IntegrationStatus;
  pullRequests: PullRequestSummary[];
  ticket: JiraTicket;
}

export type IntegrationStatusKind =
  | "error"
  | "idle"
  | "loading"
  | "ok"
  | "refreshing"
  | "warning";

export interface IntegrationStatus {
  kind: IntegrationStatusKind;
  message: string;
}

export interface ConnectionResult {
  /** Optional extra detail, e.g. resolved account/version. */
  detail?: string;
  message: string;
  ok: boolean;
}

export type EnvironmentToolName = "argocd" | "gh" | "kubectl";

export type EnvironmentToolStatus = "missing" | "ok" | "warning";

export interface EnvironmentToolCheck {
  authCommand?: string;
  command: string;
  detail?: string;
  installCommand: string;
  label: string;
  message: string;
  name: EnvironmentToolName;
  status: EnvironmentToolStatus;
}

export interface EnvironmentCheckResult {
  checkedAt: number;
  tools: EnvironmentToolCheck[];
}

/** Non-secret settings, safe to render. Secrets are stored separately. */
export interface AppConfig {
  argo: {
    /** ArgoCD app label to query, e.g. "shop". */
    app: string;
    /** kube context short name, e.g. "dev". */
    devContext: string;
  };
  github: {
    owner: string;
    repo: string;
    /** When true, reuse the local `gh` CLI token. */
    useGhCli: boolean;
  };
  jira: {
    baseUrl: string;
    /** Atlassian account email used with the Jira Cloud API token. */
    email: string;
    /** Default project key for sprint JQL, e.g. "PC". */
    project: string;
    sprintJql: string;
  };
  onboardingComplete: boolean;
  /** Devenv source path, usually ~/devenv/src. */
  repoPath: string;
}

/** Which secrets are currently stored (booleans only, never the values). */
export interface SecretStatus {
  githubToken: boolean;
  jiraToken: boolean;
}

export interface SaveConfigResult {
  config: AppConfig;
  secrets: SecretStatus;
  warning?: string;
}
