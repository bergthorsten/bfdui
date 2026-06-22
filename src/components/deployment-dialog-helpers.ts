import {
  environmentDisplayName,
  isReservedEnvironment,
  NON_PROD_ENVIRONMENTS,
  NUMERIC_ENVIRONMENT_PATTERN,
  RESERVED_ENVIRONMENTS,
} from "@/domain/environments";
import type {
  DeploymentBatch,
  DeploymentRunState,
  DevDeployment,
  TicketDeploymentRow,
  WorkflowInputDefinition,
  WorkflowTarget,
} from "@/types/bfd";

const WORKFLOW_FILE_EXTENSION_PATTERN = /\.ya?ml$/;
const LEADING_CURRENT_DIR_PATTERN = /^\.\//;
const REGEX_META_CHAR_PATTERN = /[\\^$+?.()|{}[\]]/;
const ENVIRONMENT_INPUT_NAMES = new Set(["ENVIRONMENT", "RUN_ENVIRONMENTS"]);
const TERMINAL_DEPLOYMENT_STATES = new Set<DeploymentRunState>([
  "cancelled",
  "failure",
  "success",
  "timed-out",
]);
export const DEPLOYMENT_POLLING_INTERVAL_MS = 30_000;
const DEPLOYMENT_POLLING_TIMEOUT_MS = 15 * 60_000;

export { ENVIRONMENT_INPUT_NAMES };

export interface TargetEnvironment {
  branch: string;
  cliValue: string;
  deployment?: DevDeployment;
  displayName: string;
  environment: string;
  isFree: boolean;
  kind: "dev" | "reserved" | "staging";
  reserved: boolean;
}

export interface WorkflowTargetGroup {
  group: string;
  targets: WorkflowTarget[];
}

export interface WorkflowInputGroup {
  definition: WorkflowInputDefinition;
  targets: string[];
}

export function uniqueBranches(row: TicketDeploymentRow): string[] {
  const names = [
    ...row.branches.map((branch) => branch.name),
    ...row.pullRequests.map((pr) => pr.headRef),
  ];
  const unique = [...new Set(names)];
  return unique.length > 0 ? unique : [`${row.ticket.key}-branch`];
}

export function targetLabel(target: TargetEnvironment) {
  if (target.isFree) {
    return "free";
  }
  if (target.reserved) {
    return "reserved";
  }
  if (target.kind === "staging") {
    return "staging";
  }
  return "occupied";
}

export function prioritizedTargets(
  deployments: DevDeployment[]
): TargetEnvironment[] {
  const deploymentsByEnv = new Map(
    deployments.map((deployment) => [deployment.environment, deployment])
  );

  return NON_PROD_ENVIRONMENTS.map((environment) => {
    const deployment = deploymentsByEnv.get(environment);
    const reserved = isReservedEnvironment(environment);
    const kind = targetKind(environment, reserved);

    return {
      branch: deployment?.branch ?? fallbackBranch(environment),
      cliValue: environment === "staging" ? "stage" : environment,
      deployment,
      displayName: environmentDisplayName(environment),
      environment,
      isFree: deployment?.isFree ?? false,
      kind,
      reserved,
    } satisfies TargetEnvironment;
  }).sort((a, b) => {
    const groupRank = targetGroupRank(a) - targetGroupRank(b);
    if (groupRank !== 0) {
      return groupRank;
    }
    return targetSortValue(a) - targetSortValue(b);
  });
}

export function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function preferredWorkflowAlias(target: WorkflowTarget): string {
  return target.aliases.find((alias) => alias !== target.name) ?? target.name;
}

export function rankWorkflowTargets(
  targets: WorkflowTarget[],
  row: TicketDeploymentRow
): WorkflowTarget[] {
  return targets.toSorted((a, b) => {
    const usageDelta = (b.usage?.usageCount ?? 0) - (a.usage?.usageCount ?? 0);
    if (usageDelta !== 0) {
      return usageDelta;
    }

    const lastUsedDelta =
      (b.usage?.lastUsedAt ?? 0) - (a.usage?.lastUsedAt ?? 0);
    if (lastUsedDelta !== 0) {
      return lastUsedDelta;
    }

    const contextDelta =
      workflowContextScore(b, row) - workflowContextScore(a, row);
    if (contextDelta !== 0) {
      return contextDelta;
    }

    return compareText(a.name, b.name);
  });
}

export function filterWorkflowTargets(
  targets: WorkflowTarget[],
  query: string
): WorkflowTarget[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return targets;
  }

  return targets.filter((target) =>
    [target.name, target.path, target.group, ...target.aliases].some((value) =>
      value.toLowerCase().includes(normalizedQuery)
    )
  );
}

export function groupWorkflowTargets(
  targets: WorkflowTarget[]
): WorkflowTargetGroup[] {
  const groups = new Map<string, WorkflowTarget[]>();
  for (const target of targets) {
    groups.set(target.group, [...(groups.get(target.group) ?? []), target]);
  }
  return [...groups.entries()].map(([group, groupTargets]) => ({
    group,
    targets: groupTargets,
  }));
}

export function targetsByName(
  targets: WorkflowTarget[]
): Map<string, WorkflowTarget> {
  return new Map(targets.map((target) => [target.name, target]));
}

export function workflowInputGroups(
  targets: WorkflowTarget[]
): WorkflowInputGroup[] {
  const groups = new Map<string, WorkflowInputGroup>();
  for (const target of targets) {
    for (const definition of target.inputs) {
      const key = definition.name.toUpperCase();
      const current = groups.get(key);
      if (current) {
        current.targets.push(target.name);
        continue;
      }
      groups.set(key, { definition, targets: [target.name] });
    }
  }
  return [...groups.values()].sort((a, b) =>
    compareText(a.definition.name, b.definition.name)
  );
}

export function defaultWorkflowInputValue(
  definition: WorkflowInputDefinition
): string {
  if (typeof definition.default === "string") {
    return definition.default;
  }
  if (definition.type === "boolean") {
    return "false";
  }
  return definition.options[0] ?? "";
}

export function normalizeWorkflowInputValues(
  current: Record<string, string>,
  groups: WorkflowInputGroup[]
): Record<string, string> {
  const activeNames = new Set(
    groups
      .map((group) => group.definition.name)
      .filter((name) => !ENVIRONMENT_INPUT_NAMES.has(name.toUpperCase()))
  );
  const next: Record<string, string> = {};
  for (const group of groups) {
    const { definition } = group;
    if (ENVIRONMENT_INPUT_NAMES.has(definition.name.toUpperCase())) {
      continue;
    }
    next[definition.name] =
      current[definition.name] ?? defaultWorkflowInputValue(definition);
  }
  for (const [name, value] of Object.entries(current)) {
    if (activeNames.has(name)) {
      next[name] = value;
    }
  }
  return recordsEqual(current, next) ? current : next;
}

export function workflowDispatchInputs(
  target: WorkflowTarget,
  inputValues: Record<string, string>,
  environmentValue: string
): Record<string, string> {
  const valuesByName = new Map(
    Object.entries(inputValues).map(([name, value]) => [
      name.toUpperCase(),
      value,
    ])
  );
  const inputs: Record<string, string> = {};
  for (const definition of target.inputs) {
    const normalizedName = definition.name.toUpperCase();
    const value = ENVIRONMENT_INPUT_NAMES.has(normalizedName)
      ? environmentValue
      : (valuesByName.get(normalizedName) ??
        defaultWorkflowInputValue(definition));
    if (value) {
      inputs[definition.name] = value;
    }
  }
  return inputs;
}

export function isDeploymentActive(
  batch: DeploymentBatch | null | undefined
): boolean {
  return Boolean(
    batch && !TERMINAL_DEPLOYMENT_STATES.has(batch.aggregateState)
  );
}

export function deploymentPollingInterval(
  batch: DeploymentBatch | null | undefined
): false | number {
  if (!isDeploymentActive(batch)) {
    return false;
  }

  const elapsedMs = Date.now() - batch.createdAt;
  if (elapsedMs >= DEPLOYMENT_POLLING_TIMEOUT_MS) {
    return false;
  }
  return DEPLOYMENT_POLLING_INTERVAL_MS;
}

export function deploymentPollingLabel(batch: DeploymentBatch): string {
  const interval = deploymentPollingInterval(batch);
  if (interval === false) {
    return isDeploymentActive(batch)
      ? "Polling stopped after 10 minutes. Refresh manually to check again."
      : "Polling stopped because the deployment reached a final state.";
  }
  return `Polling every ${interval / 1000}s until this deployment finishes.`;
}

export function sourceCommitShaForBranch(
  row: TicketDeploymentRow,
  branch: string
): string | undefined {
  return (
    row.pullRequests.find((pr) => pr.headRef === branch)?.headSha ??
    row.branches.find((candidate) => candidate.name === branch)?.headSha ??
    undefined
  );
}

export function targetWarning(target: TargetEnvironment | undefined) {
  if (!target) {
    return null;
  }
  if (target.kind === "staging") {
    return {
      title: "Staging target",
      body: "Staging is shared. Use this only when the branch is ready for the staging flow.",
    };
  }
  if (target.reserved) {
    return {
      title: "Reserved system",
      body: `${target.displayName} is reserved in BFD. Deploying here should be intentional.`,
    };
  }
  if (!target.isFree) {
    return {
      title: "System is not free",
      body: `Current branch: ${target.branch}. Deploying here will replace the running app.`,
    };
  }
  return null;
}

function workflowMatchesValue(target: WorkflowTarget, value: string): boolean {
  const normalizedValue = value
    .toLowerCase()
    .replace(WORKFLOW_FILE_EXTENSION_PATTERN, "");
  return [target.name, ...target.aliases].some(
    (candidate) => candidate.toLowerCase() === normalizedValue
  );
}

function workflowContextScore(
  target: WorkflowTarget,
  row: TicketDeploymentRow
): number {
  const targetValues = [target.name, ...target.aliases].map((value) =>
    value.toLowerCase()
  );
  const rowText = [
    row.ticket.key,
    row.ticket.title,
    ...row.branches.map((branch) => branch.name),
    ...row.pullRequests.flatMap((pr) => [pr.headRef, pr.title]),
  ]
    .join(" ")
    .toLowerCase();
  let score = 0;

  if (
    row.deployments.some((deployment) =>
      workflowMatchesValue(target, deployment.app)
    )
  ) {
    score += 80;
  }
  if (targetValues.some((value) => rowText.includes(value))) {
    score += 50;
  }
  if (workflowMatchesChangedFiles(target, row)) {
    score += 40;
  }
  if (target.name === "app-shop") {
    score += 10;
  }

  return score;
}

function workflowMatchesChangedFiles(
  target: WorkflowTarget,
  row: TicketDeploymentRow
): boolean {
  if (target.affectedPathGlobs.length === 0) {
    return false;
  }

  const changedFiles = row.pullRequests.flatMap((pr) => pr.changedFiles ?? []);
  return changedFiles.some((filePath) =>
    target.affectedPathGlobs.some((glob) => pathGlobMatches(glob, filePath))
  );
}

function pathGlobMatches(glob: string, filePath: string): boolean {
  const normalizedGlob = normalizePath(glob);
  const normalizedPath = normalizePath(filePath);
  let pattern = "^";

  for (const char of normalizedGlob) {
    switch (char) {
      case "*":
        pattern += ".*";
        break;
      case "?":
        pattern += ".";
        break;
      default:
        pattern += escapeRegexChar(char);
        break;
    }
  }

  return new RegExp(`${pattern}$`).test(normalizedPath);
}

function normalizePath(value: string): string {
  return value.replace(LEADING_CURRENT_DIR_PATTERN, "").replaceAll("\\", "/");
}

function escapeRegexChar(char: string): string {
  return REGEX_META_CHAR_PATTERN.test(char) ? `\\${char}` : char;
}

function targetGroupRank(target: TargetEnvironment) {
  if (target.kind === "dev" && target.isFree) {
    return 0;
  }
  if (target.kind === "dev") {
    return 1;
  }
  if (target.kind === "staging") {
    return 2;
  }
  return 3;
}

function targetSortValue(target: TargetEnvironment) {
  if (NUMERIC_ENVIRONMENT_PATTERN.test(target.environment)) {
    return Number(target.environment);
  }
  return 100 + RESERVED_ENVIRONMENTS.indexOf(target.environment);
}

function targetKind(
  environment: string,
  reserved: boolean
): TargetEnvironment["kind"] {
  if (environment === "staging") {
    return "staging";
  }
  if (reserved) {
    return "reserved";
  }
  return "dev";
}

function fallbackBranch(environment: string) {
  return environment === "staging" ? "staging" : "master";
}

function recordsEqual(
  a: Record<string, string>,
  b: Record<string, string>
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  );
}
