import { GitPullRequest, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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

export function PullRequestBadge({
  pullRequest,
}: {
  pullRequest: PullRequestSummary;
}) {
  const variant = (() => {
    if (pullRequest.isDraft) {
      return "muted";
    }
    if (pullRequest.state === "merged") {
      return "purple";
    }
    if (pullRequest.state === "open" && pullRequest.approved) {
      return "success";
    }
    if (pullRequest.state === "open") {
      return "warning";
    }
    return "muted";
  })();

  const suffix = (() => {
    if (pullRequest.isDraft) {
      return " · draft";
    }
    if (pullRequest.state === "merged") {
      return " · merged";
    }
    if (pullRequest.state === "open" && pullRequest.approved) {
      return " · approved";
    }
    return "";
  })();

  return (
    <Badge variant={variant}>
      <GitPullRequest />#{pullRequest.number}
      {suffix}
    </Badge>
  );
}
