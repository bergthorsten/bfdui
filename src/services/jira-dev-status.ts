import { messageOf } from "@/services/jira-error";
import type {
  BranchSummary,
  BuildSummary,
  JiraDevelopmentInfo,
  PullRequestSummary,
} from "@/types/bfd";

const GITHUB_PR_NUMBER_PATTERN = /\/pull\/(\d+)/;

export interface DevStatusDetailResponse {
  detail?: DevStatusDetail[];
  errors?: unknown[];
}

export interface DevStatusSummaryResponse {
  summary?: Partial<Record<DevStatusDataType, DevStatusSummaryData>>;
}

interface DevStatusSummaryData {
  byInstanceType?: Record<string, { count?: number; name?: string }>;
  overall?: { count?: number; dataType?: string; lastUpdated?: string | null };
}

export type DevStatusDataType = "branch" | "build" | "pullrequest";

export interface DevStatusTarget {
  applicationType: string;
  dataType: DevStatusDataType;
}

export interface DevStatusDetail {
  branches?: DevStatusBranch[];
  builds?: DevStatusBuild[];
  pullRequests?: DevStatusPullRequest[];
  pullrequests?: DevStatusPullRequest[];
}

interface DevStatusBranch {
  lastCommit?: { id?: string };
  name?: string;
  url?: string;
}

interface DevStatusPullRequest {
  destination?: { branch?: string };
  id?: string | number;
  lastCommit?: { id?: string };
  name?: string;
  source?: { branch?: string };
  status?: string;
  title?: string;
  url?: string;
}

interface DevStatusBuild {
  name?: string;
  status?: string;
  url?: string;
}

export function devStatusTargetsFromSummary(
  response: DevStatusSummaryResponse
): DevStatusTarget[] {
  const summary = response.summary ?? {};
  const targets: DevStatusTarget[] = [];

  for (const dataType of ["branch", "pullrequest", "build"] as const) {
    const byInstanceType = summary[dataType]?.byInstanceType ?? {};
    for (const [applicationType, instance] of Object.entries(byInstanceType)) {
      if ((instance.count ?? 0) > 0) {
        targets.push({ applicationType, dataType });
      }
    }
  }

  return targets;
}

export function fallbackDevelopmentTargets(): DevStatusTarget[] {
  return (["branch", "pullrequest", "build"] as const).map((dataType) => ({
    applicationType: "GitHub",
    dataType,
  }));
}

export function developmentInfoFromSettledDetails(
  details: PromiseSettledResult<DevStatusDetail[]>[]
): JiraDevelopmentInfo {
  const errors = details
    .filter((result) => result.status === "rejected")
    .map((result) => messageOf(result.reason));
  const allDetails = details.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );

  return {
    branches: uniqueBy(
      allDetails.flatMap((detail) =>
        (detail.branches ?? []).flatMap(branchToSummary)
      ),
      (branch) => branch.name
    ),
    pullRequests: uniqueBy(
      allDetails.flatMap((detail) =>
        detailPullRequests(detail).flatMap(pullRequestToSummary)
      ),
      (pullRequest) => pullRequest.url
    ),
    builds: allDetails.flatMap((detail) =>
      (detail.builds ?? []).flatMap(buildToSummary)
    ),
    buildCount: allDetails.reduce(
      (count, detail) => count + (detail.builds?.length ?? 0),
      0
    ),
    errors,
  };
}

export function detailPullRequests(
  detail: DevStatusDetail
): DevStatusPullRequest[] {
  return detail.pullRequests ?? detail.pullrequests ?? [];
}

function branchToSummary(branch: DevStatusBranch): BranchSummary[] {
  if (!(branch.name && branch.url)) {
    return [];
  }
  return [
    {
      name: branch.name,
      source: "jira",
      url: branch.url,
      headSha: branch.lastCommit?.id ?? "",
    },
  ];
}

function pullRequestToSummary(
  pullRequest: DevStatusPullRequest
): PullRequestSummary[] {
  if (!pullRequest.url) {
    return [];
  }

  const number = pullRequestNumber(pullRequest);
  return [
    {
      number,
      title: pullRequest.title ?? pullRequest.name ?? `Pull request #${number}`,
      url: pullRequest.url,
      headRef: pullRequest.source?.branch ?? pullRequest.name ?? "",
      baseRef: pullRequest.destination?.branch ?? "",
      state: pullRequestState(pullRequest.status),
      isDraft: false,
      approved: pullRequestApproved(pullRequest.status),
      headSha: pullRequest.lastCommit?.id ?? null,
      source: "jira",
    },
  ];
}

function buildToSummary(build: DevStatusBuild): BuildSummary[] {
  if (!build.url) {
    return [];
  }
  return [
    {
      name: build.name ?? "Build",
      status: build.status ?? "unknown",
      url: build.url,
    },
  ];
}

function pullRequestNumber(pullRequest: DevStatusPullRequest): number {
  const urlMatch = pullRequest.url?.match(GITHUB_PR_NUMBER_PATTERN);
  if (urlMatch?.[1]) {
    return Number(urlMatch[1]);
  }
  const id = Number(pullRequest.id);
  return Number.isFinite(id) ? id : 0;
}

function pullRequestState(
  status: string | undefined
): PullRequestSummary["state"] {
  const normalized = status?.toLowerCase() ?? "";
  if (normalized.includes("merged")) {
    return "merged";
  }
  if (normalized.includes("closed") || normalized.includes("declined")) {
    return "closed";
  }
  return "open";
}

function pullRequestApproved(status: string | undefined): boolean {
  return (status?.toLowerCase() ?? "").includes("approved");
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
