import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  ExternalLink,
  Loader2,
  Rocket,
  Search,
  X,
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
import {
  DEPLOYMENT_POLLING_INTERVAL_MS,
  deploymentPollingInterval,
  ENVIRONMENT_INPUT_NAMES,
  filterWorkflowTargets,
  groupWorkflowTargets,
  lastDeployedEnvironment,
  normalizeWorkflowInputValues,
  preferredWorkflowAlias,
  prioritizedTargets,
  rankWorkflowTargets,
  sourceCommitShaForBranch,
  type TargetEnvironment,
  targetLabel,
  targetsByName,
  targetWarning,
  uniqueBranches,
  type WorkflowInputGroup,
  workflowDispatchInputs,
  workflowInputGroups,
} from "@/components/deployment-dialog-helpers";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import type {
  DeploymentBatch,
  DeploymentRunState,
  DevDeployment,
  TicketDeploymentRow,
  WorkflowTarget,
} from "@/types/bfd";
import { cn } from "@/utils/tailwind";

const SELECT_CLASS =
  "h-8 w-full appearance-none rounded-md border border-border bg-background px-2.5 pr-8 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";

const INPUT_ID_PATTERN = /[^a-z0-9]+/gi;
const COMMON_BOOLEAN_INPUT_NAMES = ["PERFORM_TESTS", "FORCE_IMAGE_REBUILD"];

interface DeploymentDialogProps {
  deployments: DevDeployment[];
  onOpenChange: (open: boolean) => void;
  onSuccess?: (batch: DeploymentBatch) => void;
  open: boolean;
  row: TicketDeploymentRow;
}

function inputValueAsBoolean(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

function inputDomId(rowKey: string, name: string): string {
  return `${rowKey}-${name.toLowerCase().replace(INPUT_ID_PATTERN, "-")}`;
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

function terminalDeploymentTitle(state: DeploymentRunState): string | null {
  switch (state) {
    case "success":
      return "Deployment succeeded";
    case "failure":
      return "Deployment failed";
    case "cancelled":
      return "Deployment cancelled";
    case "timed-out":
      return "Deployment timed out";
    default:
      return null;
  }
}

function formattedTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pollingStatusLabel(
  isFetching: boolean,
  dataUpdatedAt: number
): string {
  if (isFetching) {
    return "Refreshing…";
  }
  if (dataUpdatedAt) {
    return `Checked ${formattedTime(dataUpdatedAt)}`;
  }
  return "Awaiting first check";
}

function pullRequestMeta(
  pullRequest: TicketDeploymentRow["pullRequests"][number]
): string {
  const state = (() => {
    if (pullRequest.isDraft) {
      return "draft";
    }
    if (pullRequest.state === "open" && pullRequest.approved) {
      return "approved";
    }
    return pullRequest.state;
  })();

  return `PR #${pullRequest.number} - ${state}`;
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

function humanizeInputName(name: string): string {
  const spaced = name.replaceAll("_", " ").trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function ToggleLine({
  checked,
  id,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  id: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
      <Label className="min-w-0 truncate font-medium text-sm" htmlFor={id}>
        {label}
      </Label>
      <Switch
        checked={checked}
        className="shrink-0"
        id={id}
        onCheckedChange={onCheckedChange}
      />
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
    <div className="overflow-hidden rounded-xl border border-border bg-background">
      <div className="grid grid-cols-[1.25rem_5rem_minmax(0,1fr)_5rem] gap-3 border-border border-b bg-muted/30 px-3 py-2 font-medium text-muted-foreground text-xs">
        <span aria-hidden="true" />
        <span>System</span>
        <span>Current branch</span>
        <span className="text-right">State</span>
      </div>
      <div
        aria-label="Target environment"
        className="max-h-48 divide-y divide-border/70 overflow-y-auto"
        role="listbox"
      >
        {targets.map((target) => {
          const selected = selectedEnvironment === target.environment;
          return (
            <button
              aria-selected={selected}
              className={cn(
                "grid h-12 w-full min-w-0 grid-cols-[1.25rem_5rem_minmax(0,1fr)_5rem] items-center gap-3 px-3 text-left transition-colors hover:bg-muted/40",
                selected &&
                  "bg-sky-50/80 hover:bg-sky-50 dark:bg-sky-950/20 dark:hover:bg-sky-950/25"
              )}
              key={target.environment}
              onClick={() => onSelect(target.environment)}
              role="option"
              type="button"
            >
              <span className="flex justify-center text-sky-600 dark:text-sky-400">
                {selected && <Check className="size-3.5" />}
              </span>
              <span className="font-medium text-sm">{target.displayName}</span>
              <span className="min-w-0 truncate text-muted-foreground text-sm">
                {target.branch}
              </span>
              <span
                className={cn(
                  "shrink-0 text-right text-xs",
                  target.isFree && "text-emerald-600 dark:text-emerald-400",
                  target.reserved && "text-amber-600 dark:text-amber-400",
                  target.kind === "staging" && "text-sky-600 dark:text-sky-400",
                  !(
                    target.isFree ||
                    target.reserved ||
                    target.kind === "staging"
                  ) && "text-muted-foreground"
                )}
              >
                {targetLabel(target)}
              </span>
            </button>
          );
        })}
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
        <Label className="text-muted-foreground text-xs">
          Workflow targets
        </Label>
        <span
          className={cn(
            "font-medium text-xs",
            selectedNames.length === 0
              ? "text-destructive"
              : "text-sky-700 dark:text-sky-300"
          )}
        >
          {selectedNames.length} selected
        </span>
      </div>
      <div className="relative">
        <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-8 px-8"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search workflow or alias..."
          value={query}
        />
        {query && (
          <button
            aria-label="Clear workflow search"
            className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            onClick={() => onQueryChange("")}
            type="button"
          >
            <X className="size-3.5" />
          </button>
        )}
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
        <div className="overflow-hidden rounded-xl border border-border bg-background">
          <div className="grid grid-cols-[1.25rem_minmax(0,1fr)_minmax(9rem,14rem)] gap-3 border-border border-b bg-muted/30 px-3 py-2 font-medium text-muted-foreground text-xs">
            <span aria-hidden="true" />
            <span>Workflow</span>
            <span>File</span>
          </div>
          <div
            aria-label="BFD workflow targets"
            aria-multiselectable="true"
            className="max-h-60 overflow-y-auto"
            role="listbox"
          >
            {groups.map((group) => (
              <div
                className="border-border/70 border-b last:border-b-0"
                key={group.group}
              >
                <div className="bg-muted/15 px-3 py-1.5 font-medium text-[0.625rem] text-muted-foreground uppercase tracking-wide">
                  {group.group}
                </div>
                <div className="divide-y divide-border/70">
                  {group.targets.map((target) => {
                    const selected = selectedNames.includes(target.name);
                    const alias = preferredWorkflowAlias(target);
                    const label =
                      alias === target.name
                        ? target.name
                        : `${alias} -> ${target.name}`;
                    return (
                      <button
                        aria-selected={selected}
                        className={cn(
                          "grid min-h-12 w-full min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_minmax(9rem,14rem)] items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/40",
                          selected &&
                            "bg-sky-50/80 hover:bg-sky-50 dark:bg-sky-950/20 dark:hover:bg-sky-950/25"
                        )}
                        key={target.name}
                        onClick={() => onToggle(target.name)}
                        role="option"
                        type="button"
                      >
                        <span className="flex justify-center text-sky-600 dark:text-sky-400">
                          {selected && <Check className="size-3.5" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-sm">
                            {label}
                          </span>
                        </span>
                        <span className="min-w-0 truncate text-muted-foreground text-xs">
                          {target.path}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function WorkflowInputs({
  inputGroups,
  inputValues,
  onInputChange,
  rowKey,
}: {
  inputGroups: WorkflowInputGroup[];
  inputValues: Record<string, string>;
  onInputChange: (name: string, value: string) => void;
  rowKey: string;
}) {
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
  const hasInputs = commonBooleanInputs.length > 0 || specialInputs.length > 0;

  if (!hasInputs) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Workflow inputs</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 pt-0">
        {commonBooleanInputs.map((group) => {
          const { definition } = group;
          return (
            <ToggleLine
              checked={inputValueAsBoolean(inputValues[definition.name])}
              id={inputDomId(rowKey, definition.name)}
              key={definition.name}
              label={humanizeInputName(definition.name)}
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
      </CardContent>
    </Card>
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

  if (definition.type === "boolean") {
    return (
      <ToggleLine
        checked={inputValueAsBoolean(value)}
        id={inputDomId(rowKey, definition.name)}
        label={humanizeInputName(definition.name)}
        onCheckedChange={(checked) =>
          onInputChange(definition.name, checked ? "true" : "false")
        }
      />
    );
  }

  return (
    <div className="grid gap-1.5 rounded-md border border-border px-3 py-2">
      <Label
        className="font-medium text-sm"
        htmlFor={inputDomId(rowKey, definition.name)}
      >
        {humanizeInputName(definition.name)}
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
    </div>
  );
}

function WorkflowSummary({
  branch,
  environment,
  workflows,
}: {
  branch: string;
  environment: TargetEnvironment | undefined;
  workflows: WorkflowTarget[];
}) {
  const environmentValue = environment?.cliValue ?? "01";
  const workflowCommandValue =
    workflows.map(preferredWorkflowAlias).join(" ") || "<workflow>";
  const workflowLabel = workflows.length === 1 ? "workflow" : "workflows";

  return (
    <Card>
      <CardHeader className="gap-1 pb-3">
        <CardTitle>Preflight</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-1 gap-y-1">
          Deploy <span className="font-medium text-foreground">{branch}</span>
          <span>to</span>
          <span className="rounded-md border border-yellow-300 bg-yellow-100 px-1.5 py-0.5 font-semibold text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-200">
            {environment?.displayName ?? "dev-01"}
          </span>
          <span>·</span>
          <span className="font-medium text-foreground">
            {workflows.length || "no"} {workflowLabel}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 pt-0">
        <pre className="whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
          <code>
            bfd d {workflowCommandValue} -r {branch} -e {environmentValue}
          </code>
        </pre>

        {workflows.length === 0 ? (
          <p className="text-muted-foreground text-xs">No workflow selected.</p>
        ) : (
          <ul className="grid gap-1.5">
            {workflows.map((workflow) => (
              <li
                className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-2"
                key={workflow.name}
              >
                <span className="truncate font-medium text-sm">
                  {preferredWorkflowAlias(workflow)}
                </span>
                <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground">
                  {workflow.fileName}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function DeploymentProgress({
  batch,
  dataUpdatedAt,
  error,
  isFetching,
  isLoading,
}: {
  batch: DeploymentBatch | null | undefined;
  dataUpdatedAt: number;
  error: unknown;
  isFetching: boolean;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-muted-foreground text-xs">
        <Loader2 className="size-3.5 animate-spin" />
        Loading deployment run state...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
        Deployment polling failed: {messageOf(error)}
      </div>
    );
  }

  if (!batch) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 pb-3">
        <div className="grid gap-1">
          <CardTitle>Deployment run</CardTitle>
          <CardDescription>
            {pollingStatusLabel(isFetching, dataUpdatedAt)}
          </CardDescription>
        </div>
        <Badge variant={deploymentStateTone(batch.aggregateState)}>
          {deploymentStateLabel(batch.aggregateState)}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-1.5 pt-0">
        {batch.workflows.map((workflow) => (
          <div
            className="grid gap-0.5 rounded-md border border-border bg-background px-2.5 py-2"
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
            <div className="flex items-center justify-between gap-2 text-[0.6875rem] text-muted-foreground">
              <span className="truncate font-mono">
                {workflow.runId ? `#${workflow.runId}` : "waiting for run"}
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
              <div className="text-[0.6875rem] text-destructive">
                {workflow.dispatchError}
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function DeploymentFeedback({
  batch,
  createError,
  isCreating,
}: {
  batch: DeploymentBatch | null | undefined;
  createError: unknown;
  isCreating: boolean;
}) {
  if (isCreating) {
    return null;
  }

  if (createError) {
    return (
      <Alert className="flex items-start gap-2 text-xs" variant="danger">
        <CircleX className="mt-px size-3.5 shrink-0" />
        <span>
          <span className="font-medium">Deployment failed to start. </span>
          {messageOf(createError)}
        </span>
      </Alert>
    );
  }

  if (!batch) {
    return null;
  }

  const terminalTitle = terminalDeploymentTitle(batch.aggregateState);
  if (terminalTitle) {
    const failedWorkflows = batch.workflows.filter((workflow) =>
      ["failure", "timed-out", "cancelled"].includes(workflow.state)
    );
    const succeeded = batch.aggregateState === "success";
    const detail =
      failedWorkflows.length > 0
        ? `${failedWorkflows.length} need attention`
        : `${batch.workflows.length} finished`;
    return (
      <Alert
        className="flex items-center gap-2 text-xs"
        variant={succeeded ? "success" : "danger"}
      >
        {succeeded ? (
          <CircleCheck className="size-3.5 shrink-0" />
        ) : (
          <CircleX className="size-3.5 shrink-0" />
        )}
        <span>
          <span className="font-medium">{terminalTitle}</span>
          {" · "}
          {detail}
        </span>
      </Alert>
    );
  }

  return (
    <Alert className="flex items-center gap-2 text-xs" variant="success">
      <CircleCheck className="size-3.5 shrink-0" />
      <span>
        <span className="font-medium">Deployment started</span>
        {" · "}
        {batch.workflows.length} workflow
        {batch.workflows.length === 1 ? "" : "s"} dispatched to{" "}
        {batch.environment}
      </span>
    </Alert>
  );
}

export default function DeploymentDialog({
  deployments,
  onOpenChange,
  onSuccess,
  open,
  row,
}: DeploymentDialogProps) {
  const queryClient = useQueryClient();
  const branchOptions = uniqueBranches(row);
  const preferredEnvironment = useMemo(
    () => lastDeployedEnvironment(row.deployments),
    [row.deployments]
  );
  const targets = useMemo(
    () => prioritizedTargets(deployments, preferredEnvironment),
    [deployments, preferredEnvironment]
  );
  const workflowTargetsQuery = useQuery({
    queryKey: ["bfd", "workflowTargets"],
    queryFn: getWorkflowTargets,
    retry: false,
    staleTime: 30_000,
  });

  const [branch, setBranch] = useState(branchOptions[0]);
  const [environment, setEnvironment] = useState(
    () => targets[0]?.environment ?? "01"
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
    refetchInterval: (query) => deploymentPollingInterval(query.state.data),
    staleTime: DEPLOYMENT_POLLING_INTERVAL_MS,
  });
  const createDeploymentMutation = useMutation({
    mutationFn: createDeployment,
    onSuccess: (batch) => {
      onSuccess?.(batch);
      setDeploymentBatchId(batch.id);
      queryClient.setQueryData(["bfd", "deployment", batch.id], batch);
      queryClient.setQueryData<DeploymentBatch[]>(
        ["bfd", "deployments"],
        (current) => [
          batch,
          ...(current ?? []).filter((candidate) => candidate.id !== batch.id),
        ]
      );
    },
  });
  const warning = targetWarning(selectedTarget);
  const selectedPr = row.pullRequests.find((pr) => pr.headRef === branch);
  const environmentValue = selectedTarget?.cliValue ?? environment;
  const headerMeta = [
    row.ticket.status,
    selectedPr && pullRequestMeta(selectedPr),
  ]
    .filter(Boolean)
    .join(" - ");

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

  useEffect(() => {
    if (targets.length === 0) {
      return;
    }
    if (!targets.some((target) => target.environment === environment)) {
      setEnvironment(targets[0]?.environment ?? "01");
    }
  }, [environment, targets]);

  useEffect(() => {
    const batch = deploymentBatchQuery.data;
    if (!batch) {
      return;
    }

    queryClient.setQueryData<DeploymentBatch[]>(
      ["bfd", "deployments"],
      (current) => [
        batch,
        ...(current ?? []).filter((candidate) => candidate.id !== batch.id),
      ]
    );
  }, [deploymentBatchQuery.data, queryClient]);

  function toggleWorkflowTarget(name: string) {
    setSelectedWorkflowNames((current) => {
      if (!current.includes(name)) {
        return [...current, name];
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
      <DialogContent className="max-h-[calc(100vh-0.5rem)] w-[min(calc(100vw-1rem),880px)] grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader className="pr-12">
          <DialogTitle>Deploy {row.ticket.key}</DialogTitle>
          <DialogDescription>
            <span className="block">{row.ticket.title}</span>
            {headerMeta && (
              <span className="mt-1 block text-xs">{headerMeta}</span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 overflow-y-auto p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
          <section className="grid content-start gap-4">
            <Field label="Branch/ref">
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
          </section>

          <aside className="grid min-w-0 content-start gap-3">
            <WorkflowSummary
              branch={branch}
              environment={selectedTarget}
              workflows={selectedWorkflowTargets}
            />

            <WorkflowInputs
              inputGroups={selectedInputGroups}
              inputValues={workflowInputValues}
              onInputChange={updateWorkflowInput}
              rowKey={row.ticket.key}
            />

            <DeploymentFeedback
              batch={deploymentBatchQuery.data}
              createError={createDeploymentMutation.error}
              isCreating={createDeploymentMutation.isPending}
            />

            <DeploymentProgress
              batch={deploymentBatchQuery.data}
              dataUpdatedAt={deploymentBatchQuery.dataUpdatedAt}
              error={deploymentBatchQuery.error}
              isFetching={deploymentBatchQuery.isFetching}
              isLoading={deploymentBatchQuery.isLoading}
            />

            {warning && (
              <Alert className="grid gap-0.5 text-xs" variant="warning">
                <span className="font-medium">{warning.title}</span>
                <span className="leading-relaxed">{warning.body}</span>
              </Alert>
            )}
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
