import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  GitBranch,
  Rocket,
  ShieldAlert,
  SlidersHorizontal,
} from "lucide-react";
import { type ReactNode, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { DevDeployment, TicketDeploymentRow } from "@/types/bfd";
import { cn } from "@/utils/tailwind";

const WORKFLOWS = [
  {
    value: "shop",
    resolved: "app-shop.yml",
    note: "BFD resolves the short name through the app- prefix.",
  },
  {
    value: "app-shop",
    resolved: "app-shop.yml",
    note: "Exact workflow name without .yml, as shown by BFD completion.",
  },
  {
    value: "app-api-payments",
    resolved: "app-api-payments.yml",
    note: "Regular workflow name from .github/workflows.",
  },
  {
    value: "helper-unattended-build-and-deploy",
    resolved: "helper-unattended-build-and-deploy.yml",
    note: "Helper workflow accepted by BFD completion.",
  },
] as const;

const DEV_ENVIRONMENTS = Array.from({ length: 16 }, (_, index) =>
  String(index + 1).padStart(2, "0")
);
const RESERVED_ENVIRONMENTS = ["20", "epm", "oms", "sap"];
const NON_PROD_ENVIRONMENTS = [
  ...DEV_ENVIRONMENTS,
  ...RESERVED_ENVIRONMENTS,
  "staging",
];
const NUMERIC_ENVIRONMENT_PATTERN = /^\d+$/;

const SELECT_CLASS =
  "h-8 w-full appearance-none rounded-md border border-border bg-background px-2.5 pr-8 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";

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

function targetDisplayName(environment: string) {
  if (NUMERIC_ENVIRONMENT_PATTERN.test(environment)) {
    return `dev-${environment}`;
  }
  return environment;
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
    const reserved = RESERVED_ENVIRONMENTS.includes(environment);
    const kind = targetKind(environment, reserved);

    return {
      branch: deployment?.branch ?? fallbackBranch(environment),
      cliValue: environment === "staging" ? "stage" : environment,
      deployment,
      displayName: targetDisplayName(environment),
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

function WorkflowInputs({
  forceRebuild,
  rowKey,
  runCypress,
  runTests,
  setForceRebuild,
  setRunCypress,
  setRunTests,
}: {
  forceRebuild: boolean;
  rowKey: string;
  runCypress: boolean;
  runTests: boolean;
  setForceRebuild: (checked: boolean) => void;
  setRunCypress: (checked: boolean) => void;
  setRunTests: (checked: boolean) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <SlidersHorizontal className="size-3.5" />
        Workflow inputs
      </Label>
      <div className="grid gap-2">
        <ToggleLine
          checked={runTests}
          description="Maps to PERFORM_TESTS."
          id={`${rowKey}-run-tests`}
          label="Run tests"
          onCheckedChange={setRunTests}
        />
        <ToggleLine
          checked={forceRebuild}
          description="Maps to FORCE_IMAGE_REBUILD."
          id={`${rowKey}-force-rebuild`}
          label="Force image rebuild"
          onCheckedChange={setForceRebuild}
        />
        <ToggleLine
          checked={runCypress}
          description="Shown when the workflow exposes Cypress input."
          id={`${rowKey}-run-cypress`}
          label="Run Cypress regression"
          onCheckedChange={setRunCypress}
        />
      </div>
    </div>
  );
}

function WorkflowSummary({
  branch,
  environment,
  forceRebuild,
  runCypress,
  runTests,
  workflow,
}: {
  branch: string;
  environment: TargetEnvironment | undefined;
  forceRebuild: boolean;
  runCypress: boolean;
  runTests: boolean;
  workflow: (typeof WORKFLOWS)[number];
}) {
  const environmentValue = environment?.cliValue ?? "01";
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-4">
      <div className="mb-3 flex items-center gap-2 font-medium text-sm">
        <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
        Preflight summary
      </div>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Deploy <span className="font-mono text-foreground">{branch}</span>
        {" with "}
        <span className="font-mono text-foreground">{workflow.value}</span>
        {" to "}
        <span className="font-mono text-foreground">
          {environment?.displayName ?? "dev-01"}
        </span>
        .
      </p>
      <div className="mt-3 rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-[0.6875rem] text-muted-foreground">
        bfd d {workflow.value} -r {branch} -e {environmentValue}
      </div>
      <div className="mt-3 grid gap-1.5 text-xs">
        <span className="flex items-center justify-between gap-2">
          Resolves to
          <Badge variant="outline">{workflow.resolved}</Badge>
        </span>
        <span className="text-muted-foreground">{workflow.note}</span>
      </div>
      <div className="mt-4 grid gap-2 text-xs">
        <span className="flex items-center justify-between gap-2">
          Tests
          <Badge variant={runTests ? "info" : "muted"}>
            {runTests ? "on" : "off"}
          </Badge>
        </span>
        <span className="flex items-center justify-between gap-2">
          Image rebuild
          <Badge variant={forceRebuild ? "warning" : "muted"}>
            {forceRebuild ? "forced" : "default"}
          </Badge>
        </span>
        <span className="flex items-center justify-between gap-2">
          Cypress
          <Badge variant={runCypress ? "info" : "muted"}>
            {runCypress ? "on" : "off"}
          </Badge>
        </span>
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
  const branchOptions = uniqueBranches(row);
  const targets = prioritizedTargets(deployments);

  const [branch, setBranch] = useState(branchOptions[0]);
  const [workflow, setWorkflow] = useState<string>(WORKFLOWS[0].value);
  const [environment, setEnvironment] = useState(
    targets.find((target) => target.isFree)?.environment ??
      targets[0]?.environment ??
      "01"
  );
  const [runTests, setRunTests] = useState(false);
  const [forceRebuild, setForceRebuild] = useState(false);
  const [runCypress, setRunCypress] = useState(false);

  const selectedTarget = targets.find(
    (target) => target.environment === environment
  );
  const selectedWorkflow =
    WORKFLOWS.find((option) => option.value === workflow) ?? WORKFLOWS[0];
  const warning = targetWarning(selectedTarget);
  const selectedPr = row.pullRequests.find((pr) => pr.headRef === branch);

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
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                icon={<GitBranch className="size-3.5" />}
                label="Branch/ref"
              >
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

              <Field
                icon={<Rocket className="size-3.5" />}
                label="BFD workflow"
              >
                <div className="relative">
                  <select
                    className={SELECT_CLASS}
                    onChange={(event) => setWorkflow(event.target.value)}
                    value={workflow}
                  >
                    {WORKFLOWS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.value} -&gt; {option.resolved}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                </div>
              </Field>
            </div>

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

            <WorkflowInputs
              forceRebuild={forceRebuild}
              rowKey={row.ticket.key}
              runCypress={runCypress}
              runTests={runTests}
              setForceRebuild={setForceRebuild}
              setRunCypress={setRunCypress}
              setRunTests={setRunTests}
            />
          </section>

          <aside className="grid content-start gap-3">
            <WorkflowSummary
              branch={branch}
              environment={selectedTarget}
              forceRebuild={forceRebuild}
              runCypress={runCypress}
              runTests={runTests}
              workflow={selectedWorkflow}
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

            <div className="rounded-xl border border-border p-4 text-muted-foreground text-xs leading-relaxed">
              The real action will dispatch GitHub Actions through the API and
              then poll the run URL, matching the desktop app plan.
            </div>
          </aside>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button>
            <Rocket />
            Deploy
            <ArrowRight />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
