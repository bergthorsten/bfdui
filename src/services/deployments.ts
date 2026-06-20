import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, Notification } from "electron";
import type {
  GitHubService,
  GitHubWorkflowRunSummary,
} from "@/services/github";
import type { WorkflowService } from "@/services/workflows";
import type {
  DeploymentBatch,
  DeploymentIntentInput,
  DeploymentRunState,
  DeploymentWorkflowInput,
  DeploymentWorkflowRun,
  WorkflowInputDefinition,
  WorkflowTarget,
  WorkflowTargetUsageInput,
} from "@/types/bfd";

type DeploymentGitHub = Pick<
  GitHubService,
  "dispatchWorkflow" | "getBranchHeadSha" | "listWorkflowRuns"
>;
type DeploymentWorkflows = Pick<
  WorkflowService,
  "discoverTargets" | "recordUsage"
>;

interface DeploymentNotifier {
  notify: (title: string, body: string) => void;
}

export interface DeploymentServiceOptions {
  historyPath?: string;
  idFactory?: () => string;
  notifier?: DeploymentNotifier;
  now?: () => number;
  runTimeoutMs?: number;
}

interface NormalizedDeploymentWorkflow {
  fileName: string;
  inputs: Record<string, string>;
  name: string;
  path: string;
}

interface NormalizedDeploymentIntent {
  branch: string;
  environment: string;
  sourceCommitSha?: string;
  ticketKey?: string;
  workflows: NormalizedDeploymentWorkflow[];
}

const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000;
const DISPATCH_MATCH_WINDOW_MS = 30_000;
const MAX_HISTORY_BATCHES = 100;
const HISTORY_RETENTION_MS = 24 * 60 * 60_000;
const WORKFLOW_FILE_EXTENSION_PATTERN = /\.ya?ml$/i;
const TERMINAL_DEPLOYMENT_STATES = new Set<DeploymentRunState>([
  "cancelled",
  "failure",
  "success",
  "timed-out",
]);

export class DeploymentService {
  private readonly github: DeploymentGitHub;
  private readonly historyPath: string;
  private readonly idFactory: () => string;
  private readonly notifier: DeploymentNotifier;
  private readonly now: () => number;
  private readonly runTimeoutMs: number;
  private readonly workflows: DeploymentWorkflows;

  constructor(
    github: DeploymentGitHub,
    workflows: DeploymentWorkflows,
    options: DeploymentServiceOptions = {}
  ) {
    this.github = github;
    this.workflows = workflows;
    this.historyPath =
      options.historyPath ??
      path.join(app.getPath("userData"), "deployments.json");
    this.idFactory = options.idFactory ?? randomUUID;
    this.notifier = options.notifier ?? new ElectronDeploymentNotifier();
    this.now = options.now ?? Date.now;
    this.runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  async createDeployment(
    input: DeploymentIntentInput
  ): Promise<DeploymentBatch> {
    const intent = await this.normalizeIntent(input);
    const createdAt = this.now();
    const batch: DeploymentBatch = {
      aggregateState: "pending-dispatch",
      branch: intent.branch,
      createdAt,
      environment: intent.environment,
      id: this.idFactory(),
      sourceCommitSha: intent.sourceCommitSha,
      ticketKey: intent.ticketKey,
      updatedAt: createdAt,
      workflows: intent.workflows.map((workflow) => ({
        dispatchRequestedAt: createdAt,
        environment: intent.environment,
        fileName: workflow.fileName,
        inputs: workflow.inputs,
        state: "pending-dispatch",
        targetName: workflow.name,
        workflowPath: workflow.path,
      })),
    };

    this.upsertBatch(batch);
    this.notifyStarted(batch);

    for (const run of batch.workflows) {
      await this.dispatchWorkflow(batch, run);
    }

    batch.aggregateState = aggregateDeploymentState(batch.workflows);
    batch.updatedAt = this.now();
    this.upsertBatch(batch);

    return this.refreshDeploymentBatch(batch.id);
  }

  getDeploymentBatch(id: string): DeploymentBatch | null {
    return this.readHistory().find((batch) => batch.id === id) ?? null;
  }

  listDeploymentBatches(): DeploymentBatch[] {
    return this.readHistory().toSorted((a, b) => b.createdAt - a.createdAt);
  }

  deleteDeploymentBatch(id: string): boolean {
    const batches = this.readHistory();
    const batch = batches.find((candidate) => candidate.id === id);
    if (!(batch && isTerminalDeploymentState(batch.aggregateState))) {
      return false;
    }

    const next = batches.filter((batch) => batch.id !== id);
    this.writeHistory(next);
    return true;
  }

  async refreshDeploymentBatch(id: string): Promise<DeploymentBatch> {
    const batch = this.getDeploymentBatch(id);
    if (!batch) {
      throw new Error("Deployment batch was not found.");
    }

    const previousAggregateState = batch.aggregateState;
    const usedRunIds = new Set<number>();
    const workflows: DeploymentWorkflowRun[] = [];
    for (const workflow of batch.workflows) {
      const refreshed = await this.refreshWorkflowRun(
        batch,
        workflow,
        usedRunIds
      );
      if (refreshed.runId) {
        usedRunIds.add(refreshed.runId);
      }
      workflows.push(refreshed);
    }

    const next: DeploymentBatch = {
      ...batch,
      aggregateState: aggregateDeploymentState(workflows),
      updatedAt: this.now(),
      workflows,
    };
    this.upsertBatch(next);

    if (
      !isTerminalDeploymentState(previousAggregateState) &&
      isTerminalDeploymentState(next.aggregateState)
    ) {
      this.notifyTerminal(next);
    }

    return next;
  }

  private async normalizeIntent(
    input: DeploymentIntentInput
  ): Promise<NormalizedDeploymentIntent> {
    const branch = input.branch.trim();
    const environment = input.environment.trim();
    const ticketKey = input.ticketKey?.trim();
    const sourceCommitSha = input.sourceCommitSha?.trim();

    if (!branch) {
      throw new Error("A branch/ref is required before deploying.");
    }
    if (!environment) {
      throw new Error("A target environment is required before deploying.");
    }
    if (input.workflows.length === 0) {
      throw new Error("Select at least one workflow target before deploying.");
    }

    const targets = this.workflows.discoverTargets().targets;
    const seen = new Set<string>();
    const workflows = input.workflows.flatMap((workflow) => {
      const target = resolveWorkflowTarget(targets, workflow);
      if (!target) {
        throw new Error(`Unknown workflow target: ${workflow.name}`);
      }
      if (seen.has(target.name)) {
        return [];
      }
      seen.add(target.name);

      return [
        {
          fileName: target.fileName,
          inputs: dispatchInputsForTarget(target, workflow.inputs, environment),
          name: target.name,
          path: target.path,
        },
      ];
    });

    if (workflows.length === 0) {
      throw new Error("Select at least one workflow target before deploying.");
    }

    return {
      branch,
      environment,
      sourceCommitSha:
        sourceCommitSha || (await this.getBranchHeadSha(branch)) || undefined,
      ticketKey: ticketKey || undefined,
      workflows,
    };
  }

  private async getBranchHeadSha(branch: string): Promise<string | null> {
    try {
      return await this.github.getBranchHeadSha(branch);
    } catch {
      return null;
    }
  }

  private async dispatchWorkflow(
    batch: DeploymentBatch,
    run: DeploymentWorkflowRun
  ): Promise<void> {
    run.dispatchRequestedAt = this.now();
    try {
      await this.github.dispatchWorkflow({
        inputs: run.inputs,
        ref: batch.branch,
        workflowFileName: run.fileName,
      });
      run.state = "queued";
      this.recordWorkflowUsage(batch, run);
    } catch (error) {
      run.dispatchError = messageOf(error);
      run.state = "failure";
    }
    batch.updatedAt = this.now();
    this.upsertBatch(batch);
  }

  private async refreshWorkflowRun(
    batch: DeploymentBatch,
    workflow: DeploymentWorkflowRun,
    usedRunIds: Set<number>
  ): Promise<DeploymentWorkflowRun> {
    if (isTerminalDeploymentState(workflow.state)) {
      return workflow;
    }

    const timedOut =
      this.now() - workflow.dispatchRequestedAt > this.runTimeoutMs;
    if (timedOut) {
      return { ...workflow, state: "timed-out" };
    }

    try {
      const runs = await this.github.listWorkflowRuns({
        branch: batch.branch,
        createdAfter: workflow.dispatchRequestedAt - DISPATCH_MATCH_WINDOW_MS,
        workflowFileName: workflow.fileName,
      });
      const matched = matchWorkflowRun(batch, workflow, runs, usedRunIds);
      if (!matched) {
        return {
          ...workflow,
          state:
            workflow.state === "pending-dispatch" ? "queued" : workflow.state,
        };
      }

      return {
        ...workflow,
        conclusion: matched.conclusion,
        currentAttempt: matched.currentAttempt,
        runCreatedAt: matched.createdAt,
        runId: matched.id,
        runStatus: matched.status,
        runUpdatedAt: matched.updatedAt,
        runUrl: matched.url,
        state: deploymentStateFromGitHubRun(matched),
      };
    } catch (error) {
      return {
        ...workflow,
        dispatchError: `Run polling failed: ${messageOf(error)}`,
        state:
          workflow.state === "pending-dispatch" ? "unknown" : workflow.state,
      };
    }
  }

  private recordWorkflowUsage(
    batch: DeploymentBatch,
    run: DeploymentWorkflowRun
  ): void {
    const usage: WorkflowTargetUsageInput = {
      branch: batch.branch,
      environment: batch.environment,
      name: run.targetName,
      ticketKey: batch.ticketKey,
    };
    this.workflows.recordUsage(usage);
  }

  private notifyStarted(batch: DeploymentBatch): void {
    this.notifier.notify(
      "Deployment started",
      `${batch.workflows.length} workflow${batch.workflows.length === 1 ? "" : "s"} dispatching to ${batch.environment}.`
    );
  }

  private notifyTerminal(batch: DeploymentBatch): void {
    const title = terminalNotificationTitle(batch.aggregateState);
    if (!title) {
      return;
    }
    this.notifier.notify(
      title,
      `${batch.workflows.length} workflow${batch.workflows.length === 1 ? "" : "s"} finished for ${batch.ticketKey ?? batch.branch}.`
    );
  }

  private readHistory(): DeploymentBatch[] {
    if (!existsSync(this.historyPath)) {
      return [];
    }

    try {
      const parsed = JSON.parse(readFileSync(this.historyPath, "utf8"));
      const rawBatches = Array.isArray(parsed)
        ? parsed.filter(isDeploymentBatch)
        : [];
      const batches = pruneExpiredDeploymentBatches(
        rawBatches,
        this.now()
      ).slice(0, MAX_HISTORY_BATCHES);

      if (batches.length !== rawBatches.length) {
        try {
          this.writeHistory(batches);
        } catch {
          // Keep returning readable history even if opportunistic pruning fails.
        }
      }

      return batches;
    } catch {
      return [];
    }
  }

  private upsertBatch(batch: DeploymentBatch): void {
    const batches = [
      batch,
      ...this.readHistory().filter((candidate) => candidate.id !== batch.id),
    ]
      .toSorted((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_HISTORY_BATCHES);

    this.writeHistory(batches);
  }

  private writeHistory(batches: DeploymentBatch[]): void {
    mkdirSync(path.dirname(this.historyPath), { recursive: true });
    writeFileSync(this.historyPath, JSON.stringify(batches, null, 2), "utf8");
  }
}

class ElectronDeploymentNotifier implements DeploymentNotifier {
  notify(title: string, body: string): void {
    if (!Notification.isSupported()) {
      return;
    }
    new Notification({ body, title }).show();
  }
}

function resolveWorkflowTarget(
  targets: WorkflowTarget[],
  workflow: DeploymentWorkflowInput
): WorkflowTarget | null {
  const name = normalizeWorkflowValue(workflow.name);
  const workflowPath = workflow.path?.trim().toLowerCase();
  return (
    targets.find((target) => target.name === name) ??
    targets.find((target) => target.aliases.includes(name)) ??
    targets.find(
      (target) => normalizeWorkflowValue(target.fileName) === name
    ) ??
    targets.find((target) => target.path.toLowerCase() === workflowPath) ??
    null
  );
}

function dispatchInputsForTarget(
  target: WorkflowTarget,
  providedInputs: Record<string, string>,
  environment: string
): Record<string, string> {
  const providedByName = new Map(
    Object.entries(providedInputs).map(([key, value]) => [
      key.toUpperCase(),
      value,
    ])
  );
  const inputs: Record<string, string> = {};

  for (const definition of target.inputs) {
    const normalizedName = definition.name.toUpperCase();
    let value = providedByName.get(normalizedName);
    if (
      normalizedName === "ENVIRONMENT" ||
      normalizedName === "RUN_ENVIRONMENTS"
    ) {
      value = environment;
    }
    value =
      value ?? definition.default ?? defaultWorkflowInputValue(definition);

    if (definition.required && !value) {
      throw new Error(
        `${target.name} requires workflow input ${definition.name}.`
      );
    }
    if (value) {
      inputs[definition.name] = value;
    }
  }

  return inputs;
}

function defaultWorkflowInputValue(
  definition: WorkflowInputDefinition
): string | undefined {
  if (definition.type === "boolean") {
    return "false";
  }
  return definition.options[0];
}

function matchWorkflowRun(
  batch: DeploymentBatch,
  workflow: DeploymentWorkflowRun,
  runs: GitHubWorkflowRunSummary[],
  usedRunIds: Set<number>
): GitHubWorkflowRunSummary | null {
  if (workflow.runId) {
    const existing = runs.find((run) => run.id === workflow.runId);
    if (existing) {
      return existing;
    }
  }

  const earliestCreatedAt =
    workflow.dispatchRequestedAt - DISPATCH_MATCH_WINDOW_MS;
  return (
    runs
      .filter((run) => !usedRunIds.has(run.id))
      .filter((run) => run.event === "workflow_dispatch")
      .filter((run) => run.headBranch === batch.branch)
      .filter((run) => Date.parse(run.createdAt) >= earliestCreatedAt)
      .toSorted(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
      )[0] ?? null
  );
}

function deploymentStateFromGitHubRun(
  run: GitHubWorkflowRunSummary
): DeploymentRunState {
  if (run.status === "completed") {
    switch (run.conclusion) {
      case "success":
        return "success";
      case "cancelled":
      case "skipped":
        return "cancelled";
      case "timed_out":
        return "timed-out";
      case "action_required":
      case "failure":
      case "startup_failure":
        return "failure";
      default:
        return "unknown";
    }
  }

  switch (run.status) {
    case "in_progress":
      return "in-progress";
    case "pending":
    case "queued":
    case "requested":
    case "waiting":
      return "queued";
    default:
      return "unknown";
  }
}

export function aggregateDeploymentState(
  workflows: DeploymentWorkflowRun[]
): DeploymentRunState {
  const states = workflows.map((workflow) => workflow.state);
  if (states.length === 0) {
    return "unknown";
  }
  if (states.every((state) => state === "success")) {
    return "success";
  }
  if (states.includes("failure")) {
    return "failure";
  }
  if (states.includes("timed-out")) {
    return "timed-out";
  }
  if (states.includes("cancelled")) {
    return "cancelled";
  }
  if (states.includes("in-progress")) {
    return "in-progress";
  }
  if (states.includes("queued")) {
    return "queued";
  }
  if (states.includes("pending-dispatch")) {
    return "pending-dispatch";
  }
  return "unknown";
}

function isTerminalDeploymentState(state: DeploymentRunState): boolean {
  return TERMINAL_DEPLOYMENT_STATES.has(state);
}

function pruneExpiredDeploymentBatches(
  batches: DeploymentBatch[],
  now: number
): DeploymentBatch[] {
  return batches.filter(
    (batch) =>
      !(
        isTerminalDeploymentState(batch.aggregateState) &&
        batch.updatedAt <= now - HISTORY_RETENTION_MS
      )
  );
}

function terminalNotificationTitle(state: DeploymentRunState): string | null {
  switch (state) {
    case "success":
      return "Deployment succeeded";
    case "cancelled":
      return "Deployment cancelled";
    case "failure":
      return "Deployment failed";
    case "timed-out":
      return "Deployment timed out";
    default:
      return null;
  }
}

function normalizeWorkflowValue(value: string): string {
  return path
    .basename(value.trim())
    .replace(WORKFLOW_FILE_EXTENSION_PATTERN, "")
    .toLowerCase();
}

function isDeploymentBatch(value: unknown): value is DeploymentBatch {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DeploymentBatch).id === "string" &&
    Array.isArray((value as DeploymentBatch).workflows)
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
