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
  deploymentPollingLabel,
  ENVIRONMENT_INPUT_NAMES,
  filterWorkflowTargets,
  groupWorkflowTargets,
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
import { Alert, AlertDescription } from "@/components/ui/alert";
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
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2">
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

  if (!hasInputs) {
    return null;
  }

  return (
    <div className="grid gap-2">
      <Label className="text-muted-foreground text-xs">Workflow inputs</Label>
      {environmentInputs.length > 0 && (
        <div className="text-muted-foreground text-xs">
          <span>Environment inputs: </span>
          <span className="text-foreground">
            {environmentInputs
              .map((group) => `${group.definition.name}=${environmentValue}`)
              .join(", ")}
          </span>
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
    <div className="grid gap-1.5 rounded-lg border border-border px-3 py-2">
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
    <div className="grid gap-4 border-border border-l pl-4">
      <div className="grid gap-1.5">
        <div className="font-medium text-sm">Preflight</div>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Deploy <span className="font-medium text-foreground">{branch}</span>
          {" to "}
          <span className="font-medium text-foreground">
            {environment?.displayName ?? "dev-01"}
          </span>
          {" with "}
          <span className="font-medium text-foreground">
            {workflows.length || "no"} {workflowLabel}
          </span>
          .
        </p>
      </div>
      <div className="rounded-md border border-border bg-muted/20 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
        bfd d {workflowCommandValue} -r {branch} -e {environmentValue}
      </div>
      <div className="grid gap-2 text-xs">
        <div className="font-medium text-muted-foreground">Workflows</div>
        {workflows.length === 0 && (
          <span className="text-muted-foreground">No workflow selected.</span>
        )}
        {workflows.map((workflow) => (
          <span className="grid gap-0.5" key={workflow.name}>
            <span className="font-medium">
              {preferredWorkflowAlias(workflow)}
            </span>
            <span className="truncate text-muted-foreground">
              {workflow.path}
            </span>
          </span>
        ))}
      </div>
      {workflows.length > 0 && (
        <div className="grid gap-2 text-xs">
          <div className="font-medium text-muted-foreground">Inputs</div>
          {workflows.map((workflow) => {
            const inputs = workflowDispatchInputs(
              workflow,
              inputValues,
              environmentValue
            );
            return (
              <span className="grid gap-1" key={`${workflow.name}-inputs`}>
                <span className="text-muted-foreground">{workflow.name}</span>
                <span>
                  {Object.keys(inputs).length === 0
                    ? "none"
                    : Object.entries(inputs)
                        .map(([name, value]) => `${name}=${value}`)
                        .join(", ")}
                </span>
              </span>
            );
          })}
        </div>
      )}
    </div>
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
        <div className="grid gap-0.5">
          <div className="font-medium text-sm">Deployment run</div>
          <div className="text-muted-foreground text-xs">
            {dataUpdatedAt
              ? `Last checked ${formattedTime(dataUpdatedAt)}. `
              : "Waiting for first status check. "}
            {isFetching ? "Refreshing now..." : deploymentPollingLabel(batch)}
          </div>
        </div>
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
      <Alert variant="danger">
        <AlertDescription>
          <div className="font-medium">Deployment failed to start</div>
          <div className="text-xs">{messageOf(createError)}</div>
        </AlertDescription>
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
    return (
      <Alert
        variant={batch.aggregateState === "success" ? "success" : "danger"}
      >
        <AlertDescription>
          <div className="flex items-center gap-2 font-medium">
            {batch.aggregateState === "success" ? (
              <CircleCheck className="size-4" />
            ) : (
              <CircleX className="size-4" />
            )}
            {terminalTitle}
          </div>
          <div className="mt-1 text-xs">
            {failedWorkflows.length > 0
              ? `${failedWorkflows.length} workflow${failedWorkflows.length === 1 ? "" : "s"} need attention.`
              : `${batch.workflows.length} workflow${batch.workflows.length === 1 ? "" : "s"} finished successfully.`}
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="success">
      <AlertDescription>
        <div className="flex items-center gap-2 font-medium">
          <CircleCheck className="size-4" />
          Deployment started successfully
        </div>
        <div className="mt-1 text-xs">
          {batch.workflows.length} workflow
          {batch.workflows.length === 1 ? "" : "s"} dispatched to{" "}
          {batch.environment}.
        </div>
      </AlertDescription>
    </Alert>
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
    refetchInterval: (query) => deploymentPollingInterval(query.state.data),
    staleTime: DEPLOYMENT_POLLING_INTERVAL_MS,
  });
  const createDeploymentMutation = useMutation({
    mutationFn: createDeployment,
    onSuccess: (batch) => {
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

        <div className="grid gap-6 overflow-y-auto p-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
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
              <div className="border-amber-500/60 border-l-2 pl-4 text-amber-700 text-sm dark:text-amber-300">
                <div className="mb-1 font-medium">{warning.title}</div>
                <p className="text-xs leading-relaxed">{warning.body}</p>
              </div>
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
