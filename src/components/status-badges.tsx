import {
  CircleCheck,
  Copy,
  CopyCheck,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  Lock,
} from "lucide-react";
import { type MouseEvent, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  autoSyncLabel,
  autoSyncVariant,
  healthVariant,
  jiraStatusVariant,
  syncVariant,
} from "@/lib/status";
import type {
  ArgoAutoSync,
  ArgoHealth,
  ArgoSync,
  JiraStatusCategory,
  PullRequestSummary,
} from "@/types/bfd";

export function JiraStatusBadge({
  status,
  category,
}: {
  status: string;
  category: JiraStatusCategory;
}) {
  return <Badge variant={jiraStatusVariant(status, category)}>{status}</Badge>;
}

export function SyncBadge({ sync }: { sync: ArgoSync }) {
  return <Badge variant={syncVariant(sync)}>{sync}</Badge>;
}

export function HealthBadge({ health }: { health: ArgoHealth }) {
  return <Badge variant={healthVariant(health)}>{health}</Badge>;
}

export function AutoSyncBadge({ autoSync }: { autoSync: ArgoAutoSync }) {
  return (
    <Badge variant={autoSyncVariant(autoSync)}>{autoSyncLabel(autoSync)}</Badge>
  );
}

export function ReservedBadge() {
  return (
    <Badge variant="warning">
      <Lock />
      Reserved
    </Badge>
  );
}

export function FreeBadge() {
  return <Badge variant="success">Free</Badge>;
}

function BranchCopyButton({ branch }: { branch: string }) {
  const [copied, setCopied] = useState(false);

  async function copyBranch(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    await navigator.clipboard.writeText(branch);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  const Icon = copied ? CopyCheck : Copy;

  return (
    <button
      aria-label="Copy branch name"
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      onClick={copyBranch}
      onPointerDown={(event) => event.stopPropagation()}
      type="button"
    >
      <Icon className="size-3" />
    </button>
  );
}

function formatPullRequestDate(value: string): string | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  const secondsAgo = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (secondsAgo <= 7 * 24 * 60 * 60) {
    if (secondsAgo < 60) {
      return "just now";
    }
    const minutesAgo = Math.floor(secondsAgo / 60);
    if (minutesAgo < 60) {
      return `${minutesAgo} minute${minutesAgo === 1 ? "" : "s"} ago`;
    }
    const hoursAgo = Math.floor(minutesAgo / 60);
    if (hoursAgo < 24) {
      return `${hoursAgo} hour${hoursAgo === 1 ? "" : "s"} ago`;
    }
    const daysAgo = Math.floor(hoursAgo / 24);
    return `${daysAgo} day${daysAgo === 1 ? "" : "s"} ago`;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function PullRequestTooltipContent({
  pullRequest,
  statusLabel,
}: {
  pullRequest: PullRequestSummary;
  statusLabel: string;
}) {
  const mergedAt = pullRequest.mergedAt
    ? formatPullRequestDate(pullRequest.mergedAt)
    : null;
  const updatedAt =
    !mergedAt && pullRequest.updatedAt
      ? formatPullRequestDate(pullRequest.updatedAt)
      : null;

  return (
    <div className="grid gap-1.5">
      <div className="font-medium text-foreground">
        PR {pullRequest.number} · {statusLabel}
      </div>
      {pullRequest.title && (
        <div className="text-muted-foreground">{pullRequest.title}</div>
      )}
      {pullRequest.headRef && (
        <div className="grid grid-cols-[3.75rem_1fr] gap-2">
          <span className="text-muted-foreground">Branch</span>
          <span className="flex min-w-0 items-center gap-1.5">
            <BranchCopyButton branch={pullRequest.headRef} />
            <span className="truncate font-mono">{pullRequest.headRef}</span>
          </span>
        </div>
      )}
      {mergedAt && (
        <div className="grid grid-cols-[3.75rem_1fr] gap-2">
          <span className="text-muted-foreground">Merged</span>
          <span>{mergedAt}</span>
        </div>
      )}
      {updatedAt && (
        <div className="grid grid-cols-[3.75rem_1fr] gap-2">
          <span className="text-muted-foreground">Updated</span>
          <span>{updatedAt}</span>
        </div>
      )}
    </div>
  );
}

export function PullRequestBadge({
  pullRequest,
}: {
  pullRequest: PullRequestSummary;
}) {
  const { Icon, iconClassName, label } = (() => {
    if (pullRequest.isDraft) {
      return {
        Icon: GitPullRequestDraft,
        iconClassName: "text-muted-foreground",
        label: "draft",
      };
    }
    if (pullRequest.state === "merged") {
      return {
        Icon: GitMerge,
        iconClassName: "text-violet-600 dark:text-violet-400",
        label: "merged",
      };
    }
    if (pullRequest.state === "open" && pullRequest.approved) {
      return {
        Icon: CircleCheck,
        iconClassName: "text-emerald-600 dark:text-emerald-400",
        label: "approved",
      };
    }
    return {
      Icon: GitPullRequest,
      iconClassName: "text-muted-foreground",
      label: pullRequest.state,
    };
  })();

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            className="h-5 gap-1 bg-transparent px-1.5 py-0 text-foreground"
            variant="outline"
          >
            <Icon className={`${iconClassName} size-3`} />
            <span className="translate-y-[0.5px] tabular-nums leading-none">
              {pullRequest.number}
            </span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top">
          <PullRequestTooltipContent
            pullRequest={pullRequest}
            statusLabel={label}
          />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
