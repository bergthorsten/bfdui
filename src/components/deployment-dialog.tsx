import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  GitBranch,
  Loader2,
  Rocket,
  Search,
  ShieldAlert,
  SlidersHorizontal,
} from "lucide-react";
import {
  type ReactNode,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  createDeployment,
  getWorkflowTargets,
  refreshDeploymentBatch,
} from "@/actions/bfd";
import { openExternalLink } from "@/actions/shell";
import { JiraStatusBadge, PullRequestBadge } from "@/components/status-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { cn } from "@/utils/tailwind";

const SELECT_CLASS =
  "h-8 w-full appearance-none rounded-md border border-border bg-background px-2.5 pr-8 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";

const WORKFLOW_FILE_EXTENSION_PATTERN = /\.ya?ml$/;
const INPUT_ID_PATTERN = /[^a-z0-9]+/gi;
const ENVIRONMENT_INPUT_NAMES = new Set(["ENVIRONMENT", "RUN_ENVIRONMENTS"]);
const COMMON_BOOLEAN_INPUT_NAMES = ["PERFORM_TESTS", "FORCE_IMAGE_REBUILD"];
const TERMINAL_DEPLOYMENT_STATES = new Set<DeploymentRunState>([
  "cancelled",
  "failure",
  "success",
  "timed-out",
]);

interface DeploymentDialogProps {
  deployments: DevDeployment[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  row: TicketDeploymentRow;
}

interface TargetEnvironment {
  branch: string;
  cliValue: string;
  deployment?: DevDeployment;
  displayName: string;
  environment: string;
  isFree: boolean;
  kind: "dev" | "reserved" | "staging";
  reserved: boolean;
}

function uniqueBranches(row: TicketDeploymentRow): string[] {
  const names = [
    ...row.branches.map((branch) => branch.name),
    ...row.pullRequests.map((pr) => pr.headRef),
  ];
  const unique = [...new Set(names)];
  return unique.length > 0 ? unique : [`${row.ticket.key}-branch`];
}

function targetTone(
  target: TargetEnvironment
): "success" | "warning" | "muted" | "info" {
  if (target.isFree) {
    return "success";
  }
  if (target.reserved) {
    return "warning";
  }
  if (target.kind === "staging") {
    return "info";
  }
  return "muted";
}

function targetLabel(target: TargetEnvironment) {
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
  if (environment === "staging") {
    return "staging";
  }
  return "master";
}

function prioritizedTargets(deployments: DevDeployment[]): TargetEnvironment[] {
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

interface WorkflowTargetGroup {
  group: string;
  targets: WorkflowTarget[];
}

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function preferredWorkflowAlias(target: WorkflowTarget): string {
  return target.aliases.find((alias) => alias !== target.name) ?? target.name;
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
  if (target.name === "app-shop") {
    score += 10;
  }

  return score;
}

function rankWorkflowTargets(
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

function filterWorkflowTargets(
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

function groupWorkflowTargets(
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

function targetsByName(targets: WorkflowTarget[]): Map<string, WorkflowTarget> {
  return new Map(targets.map((target) => [target.name, target]));
}

interface WorkflowInputGroup {
  definition: WorkflowInputDefinition;
  targets: string[];
}

function workflowInputGroups(targets: WorkflowTarget[]): WorkflowInputGroup[] {
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

function defaultWorkflowInputValue(
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

function inputValueAsBoolean(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

function inputDomId(rowKey: string, name: string): string {
  return `${rowKey}-${name.toLowerCase().replace(INPUT_ID_PATTERN, "-")}`;
}

function normalizeWorkflowInputValues(
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

function workflowDispatchInputs(
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

function isDeploymentActive(
  batch: DeploymentBatch | null | undefined
): boolean {
  return Boolean(
    batch && !TERMINAL_DEPLOYMENT_STATES.has(batch.aggregateState)
  );
}

function deploymentStateLabel(state: DeploymentRunState): string {
  switch (state) {
    case "pending-dispatch":
      return "dispatching";
    case "in-progress":
      return "running";
    case "timed-out":
      return "timed out";
    default:
      return state;
  }
}

function deploymentStateTone(
  state: DeploymentRunState
): "danger" | "info" | "muted" | "success" | "warning" {
  switch (state) {
    case "success":
      return "success";
    case "failure":
    case "timed-out":
      return "danger";
    case "cancelled":
      return "warning";
    case "in-progress":
    case "queued":
      return "info";
    default:
      return "muted";
  }
}

function sourceCommitShaForBranch(
  row: TicketDeploymentRow,
  branch: string
): string | undefined {
  return (
    row.pullRequests.find((pr) => pr.headRef === branch)?.headSha ??
    row.branches.find((candidate) => candidate.name === branch)?.headSha ??
    undefined
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function targetWarning(target: TargetEnvironment | undefined) {
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

function Field({
  label,
  children,
  icon,
}: {
  children: ReactNode;
  icon?: ReactNode;
  label: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="flex items-center gap-1.5 text-muted-foreground text-xs">
        {icon}
        {label}
      </Label>
      {children}
    </div>
  );
}

function ToggleLine({
  checked,
  description,
  id,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  description: string;
  id: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-3 py-2">
      <span className="grid gap-0.5">
        <Label className="cursor-pointer text-sm" htmlFor={id}>
          {label}
        </Label>
        <span className="text-muted-foreground text-xs">{description}</span>
      </span>
      <Switch checked={checked} id={id} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function TargetList({
  selectedEnvironment,
  targets,
  onSelect,
}: {
  onSelect: (environment: string) => void;
  selectedEnvironment: string;
  targets: TargetEnvironment[];
}) {
  return (
    <div className="max-h-60 overflow-y-auto rounded-xl border border-border bg-muted/20 p-1">
      <div
        aria-label="Target environment"
        className="grid gap-1"
        role="listbox"
      >
        {targets.map((target) => (
          <button
            aria-selected={selectedEnvironment === target.environment}
            className={cn(
              "flex h-9 min-w-0 items-center gap-3 rounded-lg px-3 text-left transition-colors hover:bg-background",
              selectedEnvironment === target.environment &&
                "bg-background shadow-xs ring-1 ring-primary/30"
            )}
            key={target.environment}
            onClick={() => onSelect(target.environment)}
            role="option"
            type="button"
          >
            <span className="w-16 shrink-0 font-mono font-semibold text-xs">
              {target.displayName}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
              {target.branch}
            </span>
            <Badge className="shrink-0" variant={targetTone(target)}>
              {targetLabel(target)}
            </Badge>
          </button>
        ))}
      </div>
    </div>
  );
}

function WorkflowTargetSelector({
  error,
  isLoading,
  onQueryChange,
  onToggle,
  query,
  selectedNames,
  targets,
  warnings,
}: {
  error: unknown;
  isLoading: boolean;
  onQueryChange: (value: string) => void;
  onToggle: (name: string) => void;
  query: string;
  selectedNames: string[];
  targets: WorkflowTarget[];
  warnings: string[];
}) {
  const groups = groupWorkflowTargets(targets);

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <Rocket className="size-3.5" />
          Workflow targets
        </Label>
        <Badge variant="outline">{selectedNames.length} selected</Badge>
      </div>
      <div className="relative">
        <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-8 pl-8"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search workflow or alias..."
          value={query}
        />
      </div>

      {warnings.map((warning) => (
        <div
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-700 text-xs dark:text-amber-300"
          key={warning}
        >
          {warning}
        </div>
      ))}

      {Boolean(error) && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
          Workflow discovery failed: {messageOf(error)}
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/20 px-3 py-3 text-muted-foreground text-xs">
          <Loader2 className="size-3.5 animate-spin" />
          Loading deployable workflow targets from the local checkout...
        </div>
      )}

      {!isLoading && targets.length === 0 && (
        <div className="rounded-xl border border-border bg-muted/20 px-3 py-3 text-muted-foreground text-xs">
          {query.trim()
            ? "No discovered workflow target matches this search."
            : "No deployable workflow_dispatch targets found. Check the configured repo path and workflow files."}
        </div>
      )}

      {groups.length > 0 && (
        <div className="max-h-60 overflow-y-auto rounded-xl border border-border bg-muted/20 p-1">
          <div
            aria-label="BFD workflow targets"
            aria-multiselectable="true"
            className="grid gap-2"
            role="listbox"
          >
            {groups.map((group) => (
              <div className="grid gap-1" key={group.group}>
                <div className="px-2 pt-1 font-medium text-[0.625rem] text-muted-foreground uppercase tracking-wide">
                  {group.group}
                </div>
                {group.targets.map((target) => {
                  const selected = selectedNames.includes(target.name);
                  const alias = preferredWorkflowAlias(target);
                  return (
                    <button
                      aria-selected={selected}
                      className={cn(
                        "flex min-h-11 min-w-0 items-center gap-3 rounded-lg px-3 text-left transition-colors hover:bg-background",
                        selected &&
                          "bg-background shadow-xs ring-1 ring-primary/30"
                      )}
                      key={target.name}
                      onClick={() => onToggle(target.name)}
                      role="option"
                      type="button"
                    >
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded-full border border-border",
                          selected &&
                            "border-primary bg-primary text-primary-foreground"
                        )}
                      >
                        {selected && <CheckCircle2 className="size-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium font-mono text-xs">
                          {alias === target.name ? "" : `${alias} -> `}
                          {target.name}
                        </span>
                        <span className="block truncate text-[0.6875rem] text-muted-foreground">
                          {target.path}
                        </span>
                      </span>
                      {target.usage && (
                        <Badge className="shrink-0" variant="info">
                          {target.usage.usageCount} use
                          {target.usage.usageCount === 1 ? "" : "s"}
                        </Badge>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function WorkflowInputs({
  environmentValue,
  inputGroups,
  inputValues,
  onInputChange,
  rowKey,
}: {
  environmentValue: string;
  inputGroups: WorkflowInputGroup[];
  inputValues: Record<string, string>;
  onInputChange: (name: string, value: string) => void;
  rowKey: string;
}) {
  const environmentInputs = inputGroups.filter((group) =>
    ENVIRONMENT_INPUT_NAMES.has(group.definition.name.toUpperCase())
  );
  const commonBooleanInputs = inputGroups.filter((group) =>
    COMMON_BOOLEAN_INPUT_NAMES.includes(group.definition.name.toUpperCase())
  );
  const specialInputs = inputGroups.filter((group) => {
    const name = group.definition.name.toUpperCase();
    return !(
      ENVIRONMENT_INPUT_NAMES.has(name) ||
      COMMON_BOOLEAN_INPUT_NAMES.includes(name)
    );
  });
  const hasInputs =
    environmentInputs.length > 0 ||
    commonBooleanInputs.length > 0 ||
    specialInputs.length > 0;

  return (
    <div className="grid gap-2">
      <Label className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <SlidersHorizontal className="size-3.5" />
        Workflow inputs
      </Label>
      {!hasInputs && (
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-muted-foreground text-xs">
          Selected workflows do not declare workflow_dispatch inputs.
        </div>
      )}
      {environmentInputs.length > 0 && (
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs">
          <div className="mb-1 font-medium">Environment-driven inputs</div>
          <div className="flex flex-wrap gap-1">
            {environmentInputs.map((group) => (
              <Badge key={group.definition.name} variant="outline">
                {group.definition.name}={environmentValue}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {commonBooleanInputs.map((group) => {
        const { definition } = group;
        return (
          <ToggleLine
            checked={inputValueAsBoolean(inputValues[definition.name])}
            description={
              definition.description || `Used by ${group.targets.join(", ")}.`
            }
            id={inputDomId(rowKey, definition.name)}
            key={definition.name}
            label={definition.name.replaceAll("_", " ").toLowerCase()}
            onCheckedChange={(checked) =>
              onInputChange(definition.name, checked ? "true" : "false")
            }
          />
        );
      })}
      {specialInputs.map((group) => (
        <WorkflowInputControl
          group={group}
          key={group.definition.name}
          onInputChange={onInputChange}
          rowKey={rowKey}
          value={inputValues[group.definition.name] ?? ""}
        />
      ))}
    </div>
  );
}

function WorkflowInputControl({
  group,
  onInputChange,
  rowKey,
  value,
}: {
  group: WorkflowInputGroup;
  onInputChange: (name: string, value: string) => void;
  rowKey: string;
  value: string;
}) {
  const { definition } = group;
  const description =
    definition.description || `Used by ${group.targets.join(", ")}.`;

  if (definition.type === "boolean") {
    return (
      <ToggleLine
        checked={inputValueAsBoolean(value)}
        description={description}
        id={inputDomId(rowKey, definition.name)}
        label={definition.name}
        onCheckedChange={(checked) =>
          onInputChange(definition.name, checked ? "true" : "false")
        }
      />
    );
  }

  return (
    <div className="grid gap-1.5 rounded-lg border border-border bg-card px-3 py-2">
      <Label
        className="font-medium text-xs"
        htmlFor={inputDomId(rowKey, definition.name)}
      >
        {definition.name}
      </Label>
      {definition.options.length > 0 ? (
        <div className="relative">
          <select
            className={SELECT_CLASS}
            id={inputDomId(rowKey, definition.name)}
            onChange={(event) =>
              onInputChange(definition.name, event.target.value)
            }
            value={value}
          >
            {definition.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        </div>
      ) : (
        <Input
          id={inputDomId(rowKey, definition.name)}
          onChange={(event) =>
            onInputChange(definition.name, event.target.value)
          }
          value={value}
        />
      )}
      <span className="text-muted-foreground text-xs">{description}</span>
    </div>
  );
}

function WorkflowSummary({
  branch,
  environment,
  inputValues,
  workflows,
}: {
  branch: string;
  environment: TargetEnvironment | undefined;
  inputValues: Record<string, string>;
  workflows: WorkflowTarget[];
}) {
  const environmentValue = environment?.cliValue ?? "01";
  const workflowCommandValue =
    workflows.map(preferredWorkflowAlias).join(" ") || "<workflow>";
  const workflowLabel = workflows.length === 1 ? "workflow" : "workflows";
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-4">
      <div className="mb-3 flex items-center gap-2 font-medium text-sm">
        <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
        Preflight summary
      </div>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Deploy <span className="font-mono text-foreground">{branch}</span>
        {" with "}
        <span className="font-mono text-foreground">
          {workflows.length || "no"} {workflowLabel}
        </span>
        {" to "}
        <span className="font-mono text-foreground">
          {environment?.displayName ?? "dev-01"}
        </span>
        .
      </p>
      <div className="mt-3 rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-[0.6875rem] text-muted-foreground">
        bfd d {workflowCommandValue} -r {branch} -e {environmentValue}
      </div>
      <div className="mt-3 grid gap-1.5 text-xs">
        <span className="flex items-center justify-between gap-2">
          Selected targets
          <Badge variant={workflows.length ? "info" : "muted"}>
            {workflows.length}
          </Badge>
        </span>
        {workflows.map((workflow) => (
          <span
            className="flex items-center justify-between gap-2"
            key={workflow.name}
          >
            <span className="min-w-0 truncate font-mono">
              {preferredWorkflowAlias(workflow)}
            </span>
            <Badge className="max-w-40 truncate" variant="outline">
              {workflow.path}
            </Badge>
          </span>
        ))}
      </div>
      <div className="mt-4 grid gap-2 text-xs">
        {workflows.length === 0 && (
          <span className="text-muted-foreground">No dispatch inputs.</span>
        )}
        {workflows.map((workflow) => {
          const inputs = workflowDispatchInputs(
            workflow,
            inputValues,
            environmentValue
          );
          return (
            <span className="grid gap-1" key={`${workflow.name}-inputs`}>
              <span className="font-mono text-muted-foreground">
                {workflow.name} inputs
              </span>
              <span className="flex flex-wrap gap-1">
                {Object.keys(inputs).length === 0 ? (
                  <Badge variant="muted">none</Badge>
                ) : (
                  Object.entries(inputs).map(([name, value]) => (
                    <Badge key={name} variant="outline">
                      {name}={value}
                    </Badge>
                  ))
                )}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function DeploymentProgress({
  batch,
  error,
  isLoading,
}: {
  batch: DeploymentBatch | null | undefined;
  error: unknown;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-muted/20 p-4 text-muted-foreground text-xs">
        <div className="flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" />
          Loading deployment run state...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-destructive text-xs">
        Deployment polling failed: {messageOf(error)}
      </div>
    );
  }

  if (!batch) {
    return null;
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="font-medium text-sm">Deployment run</div>
        <Badge variant={deploymentStateTone(batch.aggregateState)}>
          {deploymentStateLabel(batch.aggregateState)}
        </Badge>
      </div>
      <div className="grid gap-2">
        {batch.workflows.map((workflow) => (
          <div
            className="grid gap-1 rounded-lg border border-border bg-background px-3 py-2"
            key={`${workflow.targetName}-${workflow.environment}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-xs">
                {workflow.targetName}
              </span>
              <Badge variant={deploymentStateTone(workflow.state)}>
                {deploymentStateLabel(workflow.state)}
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
              <span className="truncate">
                {workflow.runId ? `run #${workflow.runId}` : "waiting for run"}
              </span>
              {workflow.runUrl && (
                <button
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                  onClick={() => openExternalLink(workflow.runUrl ?? "")}
                  type="button"
                >
                  Open run
                  <ExternalLink className="size-3" />
                </button>
              )}
            </div>
            {workflow.dispatchError && (
              <div className="text-destructive text-xs">
                {workflow.dispatchError}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DeploymentDialog({
  deployments,
  open,
  onOpenChange,
  row,
}: DeploymentDialogProps) {
  const queryClient = useQueryClient();
  const branchOptions = uniqueBranches(row);
  const targets = prioritizedTargets(deployments);
  const workflowTargetsQuery = useQuery({
    queryKey: ["bfd", "workflowTargets"],
    queryFn: getWorkflowTargets,
    retry: false,
    staleTime: 30_000,
  });

  const [branch, setBranch] = useState(branchOptions[0]);
  const [environment, setEnvironment] = useState(
    targets.find((target) => target.isFree)?.environment ??
      targets[0]?.environment ??
      "01"
  );
  const [workflowQuery, setWorkflowQuery] = useState("");
  const [selectedWorkflowNames, setSelectedWorkflowNames] = useState<string[]>(
    []
  );
  const [workflowInputValues, setWorkflowInputValues] = useState<
    Record<string, string>
  >({});
  const [deploymentBatchId, setDeploymentBatchId] = useState<string | null>(
    null
  );
  const deferredWorkflowQuery = useDeferredValue(workflowQuery);
  const workflowTargets = workflowTargetsQuery.data?.targets ?? [];
  const rankedWorkflowTargets = useMemo(
    () => rankWorkflowTargets(workflowTargets, row),
    [workflowTargets, row]
  );
  const visibleWorkflowTargets = useMemo(
    () => filterWorkflowTargets(rankedWorkflowTargets, deferredWorkflowQuery),
    [rankedWorkflowTargets, deferredWorkflowQuery]
  );
  const workflowTargetMap = useMemo(
    () => targetsByName(workflowTargets),
    [workflowTargets]
  );

  const selectedTarget = targets.find(
    (target) => target.environment === environment
  );
  const selectedWorkflowTargets = useMemo(
    () =>
      selectedWorkflowNames
        .map((name) => workflowTargetMap.get(name))
        .filter((target): target is WorkflowTarget => Boolean(target)),
    [selectedWorkflowNames, workflowTargetMap]
  );
  const selectedInputGroups = useMemo(
    () => workflowInputGroups(selectedWorkflowTargets),
    [selectedWorkflowTargets]
  );
  const deploymentBatchQuery = useQuery({
    enabled: Boolean(deploymentBatchId),
    queryFn: () => refreshDeploymentBatch(deploymentBatchId ?? ""),
    queryKey: ["bfd", "deployment", deploymentBatchId],
    refetchInterval: (query) =>
      isDeploymentActive(query.state.data) ? 5000 : false,
  });
  const createDeploymentMutation = useMutation({
    mutationFn: createDeployment,
    onSuccess: (batch) => {
      setDeploymentBatchId(batch.id);
      queryClient.setQueryData(["bfd", "deployment", batch.id], batch);
      queryClient.invalidateQueries({ queryKey: ["bfd", "deployments"] });
    },
  });
  const warning = targetWarning(selectedTarget);
  const selectedPr = row.pullRequests.find((pr) => pr.headRef === branch);
  const environmentValue = selectedTarget?.cliValue ?? environment;

  useEffect(() => {
    setSelectedWorkflowNames((current) => {
      const validNames = new Set(
        rankedWorkflowTargets.map((target) => target.name)
      );
      const next = current.filter((name) => validNames.has(name));
      if (next.length === 0 && rankedWorkflowTargets[0]) {
        next.push(rankedWorkflowTargets[0].name);
      }
      if (
        next.length === current.length &&
        next.every((name, index) => name === current[index])
      ) {
        return current;
      }
      return next;
    });
  }, [rankedWorkflowTargets]);

  useEffect(() => {
    setWorkflowInputValues((current) =>
      normalizeWorkflowInputValues(current, selectedInputGroups)
    );
  }, [selectedInputGroups]);

  function toggleWorkflowTarget(name: string) {
    setSelectedWorkflowNames((current) => {
      if (!current.includes(name)) {
        return [...current, name];
      }
      if (current.length === 1) {
        return current;
      }
      return current.filter((selectedName) => selectedName !== name);
    });
  }

  function updateWorkflowInput(name: string, value: string) {
    setWorkflowInputValues((current) => ({ ...current, [name]: value }));
  }

  function submitDeployment() {
    if (!selectedTarget || selectedWorkflowTargets.length === 0) {
      return;
    }

    createDeploymentMutation.mutate({
      branch,
      environment: environmentValue,
      sourceCommitSha: sourceCommitShaForBranch(row, branch),
      ticketKey: row.ticket.key,
      workflows: selectedWorkflowTargets.map((target) => ({
        inputs: workflowDispatchInputs(
          target,
          workflowInputValues,
          environmentValue
        ),
        name: target.name,
        path: target.path,
      })),
    });
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[calc(100vh-0.5rem)] w-[min(calc(100vw-1rem),820px)]">
        <DialogHeader className="pr-12">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{row.ticket.key}</Badge>
            <JiraStatusBadge
              category={row.ticket.statusCategory}
              status={row.ticket.status}
            />
            {selectedPr && <PullRequestBadge pullRequest={selectedPr} />}
          </div>
          <DialogTitle>Deploy ticket branch</DialogTitle>
          <DialogDescription>{row.ticket.title}</DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[calc(100vh-10.5rem)] gap-5 overflow-auto p-5 lg:grid-cols-[1fr_18rem]">
          <section className="grid content-start gap-4">
            <Field icon={<GitBranch className="size-3.5" />} label="Branch/ref">
              <div className="relative">
                <select
                  className={SELECT_CLASS}
                  onChange={(event) => setBranch(event.target.value)}
                  value={branch}
                >
                  {branchOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              </div>
            </Field>

            <div className="grid gap-2">
              <Label className="text-muted-foreground text-xs">
                Target dev system
              </Label>
              <TargetList
                onSelect={setEnvironment}
                selectedEnvironment={environment}
                targets={targets}
              />
            </div>

            <WorkflowTargetSelector
              error={workflowTargetsQuery.error}
              isLoading={workflowTargetsQuery.isLoading}
              onQueryChange={setWorkflowQuery}
              onToggle={toggleWorkflowTarget}
              query={workflowQuery}
              selectedNames={selectedWorkflowNames}
              targets={visibleWorkflowTargets}
              warnings={workflowTargetsQuery.data?.warnings ?? []}
            />

            <WorkflowInputs
              environmentValue={environmentValue}
              inputGroups={selectedInputGroups}
              inputValues={workflowInputValues}
              onInputChange={updateWorkflowInput}
              rowKey={row.ticket.key}
            />
          </section>

          <aside className="grid content-start gap-3">
            <WorkflowSummary
              branch={branch}
              environment={selectedTarget}
              inputValues={workflowInputValues}
              workflows={selectedWorkflowTargets}
            />

            <DeploymentProgress
              batch={deploymentBatchQuery.data}
              error={deploymentBatchQuery.error}
              isLoading={deploymentBatchQuery.isLoading}
            />

            {warning && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-700 text-sm dark:text-amber-300">
                <div className="mb-1 flex items-center gap-2 font-medium">
                  <ShieldAlert className="size-4" />
                  {warning.title}
                </div>
                <p className="text-xs leading-relaxed">{warning.body}</p>
              </div>
            )}

            {createDeploymentMutation.error && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-destructive text-sm">
                <div className="mb-1 flex items-center gap-2 font-medium">
                  <ShieldAlert className="size-4" />
                  Deployment failed to start
                </div>
                <p className="text-xs leading-relaxed">
                  {messageOf(createDeploymentMutation.error)}
                </p>
              </div>
            )}

            <div className="rounded-xl border border-border p-4 text-muted-foreground text-xs leading-relaxed">
              Deploy dispatches GitHub Actions through the API and then polls
              workflow_dispatch runs until they finish or time out.
            </div>
          </aside>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            disabled={
              createDeploymentMutation.isPending ||
              selectedWorkflowTargets.length === 0 ||
              workflowTargetsQuery.isLoading
            }
            onClick={submitDeployment}
          >
            {createDeploymentMutation.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Rocket />
            )}
            Deploy
            <ArrowRight />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
