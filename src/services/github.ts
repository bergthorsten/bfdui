import { githubBranchUrl, githubPullRequestUrl } from "@/domain/urls";
import { execCli } from "@/services/cli";
import type { ConfigService } from "@/services/config";
import type {
  BranchSummary,
  ConnectionResult,
  JiraDevelopmentInfo,
  PullRequestSummary,
} from "@/types/bfd";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_PR_NUMBER_PATTERN = /\/pull\/(\d+)/;
const GH_CLI_TOKEN_CACHE_MS = 60_000;
const GITHUB_DISCOVERY_LIMIT = 20;
const GITHUB_BRANCH_REF_PREFIX = "refs/heads/";

interface GitHubBranchRefResponse {
  object?: { sha?: string };
  ref?: string;
}

interface GitHubWorkflowRunsResponse {
  workflow_runs?: GitHubWorkflowRunResponse[];
}

interface GitHubWorkflowJobsResponse {
  jobs?: GitHubWorkflowJobResponse[];
}

interface GitHubCommitCompareResponse {
  ahead_by?: number;
  base_commit?: { sha?: string };
  commits?: GitHubCommitListItemResponse[];
  html_url?: string;
  status?: string;
}

interface GitHubCommitListItemResponse {
  html_url?: string;
  sha?: string;
}

interface GitHubWorkflowRunResponse {
  conclusion?: string | null;
  created_at?: string;
  event?: string;
  head_branch?: string | null;
  html_url?: string;
  id?: number;
  run_attempt?: number;
  status?: string | null;
  updated_at?: string;
}

interface GitHubWorkflowJobResponse {
  conclusion?: string | null;
  completed_at?: string | null;
  html_url?: string;
  id?: number;
  name?: string;
  started_at?: string | null;
  status?: string | null;
}

export interface GitHubWorkflowRunSummary {
  conclusion: string | null;
  createdAt: string;
  currentAttempt: number;
  event: string;
  headBranch: string | null;
  id: number;
  status: string | null;
  updatedAt: string;
  url: string;
}

export interface GitHubWorkflowJobSummary {
  completedAt: string | null;
  conclusion: string | null;
  id: number;
  name: string;
  startedAt: string | null;
  status: string | null;
  url: string;
}

export interface GitHubBranchFreshness {
  aheadBy: number | null;
  latestCommitSha: string | null;
  method: "compare" | "since-date";
  status: string;
  url: string | null;
}

interface GitHubIssueSearchResponse {
  items?: GitHubIssueSearchItem[];
}

interface GitHubIssueSearchItem {
  html_url?: string;
  number?: number;
  pull_request?: unknown;
  state?: "closed" | "open";
  title?: string;
  updated_at?: string;
}

interface GitHubPullRequestResponse {
  base?: { ref?: string };
  draft?: boolean;
  head?: { ref?: string; sha?: string };
  html_url?: string;
  merged_at?: string | null;
  number?: number;
  state?: "closed" | "open";
  title?: string;
  updated_at?: string;
}

export interface GitHubReviewResponse {
  state?: string;
  submitted_at?: string | null;
  user?: { id?: number; login?: string } | null;
}

type GitHubConfigProvider = Pick<ConfigService, "get" | "getSecret">;

export class GitHubService {
  private readonly config: GitHubConfigProvider;
  private ghCliTokenCache: { expiresAt: number; value: string | null } | null =
    null;
  private ghCliTokenRequest: Promise<string | null> | null = null;

  constructor(config: GitHubConfigProvider) {
    this.config = config;
  }

  async testConnection(): Promise<ConnectionResult> {
    const { github } = this.config.get();

    try {
      const token = await this.token();
      if (!token) {
        return {
          ok: false,
          message: github.useGhCli
            ? "No GitHub token found via gh CLI."
            : "No GitHub token configured.",
        };
      }

      const repo = await this.request<{
        default_branch?: string;
        full_name?: string;
      }>(this.repoApiPath(), token);

      return {
        ok: true,
        message: "Connected to GitHub.",
        detail: `${repo.full_name ?? `${github.owner}/${github.repo}`} · ${repo.default_branch ?? "default branch unknown"}`,
      };
    } catch (error) {
      return { ok: false, message: githubErrorMessage(error) };
    }
  }

  async enrichDevelopmentInfo(
    info: JiraDevelopmentInfo
  ): Promise<JiraDevelopmentInfo> {
    const token = await this.token();
    if (!token) {
      return info;
    }

    return this.enrichDevelopmentInfoWithToken(info, token);
  }

  async completeDevelopmentInfo(
    ticketKey: string,
    info: JiraDevelopmentInfo
  ): Promise<JiraDevelopmentInfo> {
    const token = await this.token();
    const missingBranches = info.branches.length === 0;
    const missingPullRequests = info.pullRequests.length === 0;
    const needsFallback = missingBranches || missingPullRequests;
    if (!token) {
      return needsFallback
        ? appendError(info, this.missingTokenMessage())
        : info;
    }

    const enrichedInfo = await this.enrichDevelopmentInfoWithToken(info, token);
    if (!(needsFallback && ticketKey.trim())) {
      return enrichedInfo;
    }

    const fallbackInfo = await this.discoverDevelopmentInfoWithToken(
      ticketKey.trim().toUpperCase(),
      token
    ).catch((error) =>
      emptyDevelopmentInfo([
        `GitHub fallback discovery failed: ${githubErrorMessage(error)}`,
      ])
    );

    return mergeDevelopmentInfo(enrichedInfo, fallbackInfo, {
      branches: missingBranches,
      pullRequests: missingPullRequests,
    });
  }

  async discoverDevelopmentInfo(
    ticketKey: string
  ): Promise<JiraDevelopmentInfo> {
    const token = await this.token();
    if (!token) {
      return emptyDevelopmentInfo([this.missingTokenMessage()]);
    }

    return this.discoverDevelopmentInfoWithToken(
      ticketKey.trim().toUpperCase(),
      token
    );
  }

  async dispatchWorkflow(input: {
    inputs: Record<string, string>;
    ref: string;
    workflowFileName: string;
  }): Promise<void> {
    const token = await this.token();
    if (!token) {
      throw new Error(this.missingTokenMessage());
    }

    await this.request<void>(
      `${this.repoApiPath()}/actions/workflows/${encodeURIComponent(input.workflowFileName)}/dispatches`,
      token,
      {
        body: JSON.stringify({ inputs: input.inputs, ref: input.ref }),
        method: "POST",
      }
    );
  }

  async getBranchHeadSha(ref: string): Promise<string | null> {
    const token = await this.token();
    if (!token) {
      return null;
    }

    const normalizedRef = ref.trim();
    if (!normalizedRef) {
      return null;
    }

    const refs = await this.request<GitHubBranchRefResponse[]>(
      `${this.repoApiPath()}/git/matching-refs/heads/${encodeURIComponent(normalizedRef)}`,
      token
    );
    const match = refs.find(
      (candidate) => branchNameFromRef(candidate.ref) === normalizedRef
    );
    return match?.object?.sha ?? null;
  }

  async listWorkflowRuns(input: {
    branch: string;
    createdAfter?: number;
    workflowFileName: string;
  }): Promise<GitHubWorkflowRunSummary[]> {
    const token = await this.token();
    if (!token) {
      throw new Error(this.missingTokenMessage());
    }

    const params = new URLSearchParams({
      branch: input.branch,
      event: "workflow_dispatch",
      per_page: "30",
    });
    if (input.createdAfter) {
      params.set("created", `>=${new Date(input.createdAfter).toISOString()}`);
    }

    const response = await this.request<GitHubWorkflowRunsResponse>(
      `${this.repoApiPath()}/actions/workflows/${encodeURIComponent(input.workflowFileName)}/runs?${params}`,
      token
    );

    return (response.workflow_runs ?? []).flatMap(githubWorkflowRunToSummary);
  }

  async listWorkflowRunJobs(runId: number): Promise<GitHubWorkflowJobSummary[]> {
    const token = await this.token();
    if (!token) {
      throw new Error(this.missingTokenMessage());
    }

    const params = new URLSearchParams({ filter: "latest", per_page: "100" });
    const response = await this.request<GitHubWorkflowJobsResponse>(
      `${this.repoApiPath()}/actions/runs/${runId}/jobs?${params}`,
      token
    );

    return (response.jobs ?? []).flatMap(githubWorkflowJobToSummary);
  }

  async getBranchFreshness(input: {
    branch: string;
    deployedAt: string | null;
    deployedRevision?: string | null;
  }): Promise<GitHubBranchFreshness | null> {
    const token = await this.token();
    if (!token) {
      return null;
    }

    if (input.deployedRevision) {
      const comparison = await this.request<GitHubCommitCompareResponse>(
        `${this.repoApiPath()}/compare/${encodeURIComponent(input.deployedRevision)}...${encodeURIComponent(input.branch)}`,
        token
      );
      return {
        aheadBy: comparison.ahead_by ?? null,
        latestCommitSha: comparison.commits?.at(-1)?.sha ?? null,
        method: "compare",
        status: comparison.status ?? "unknown",
        url: comparison.html_url ?? null,
      };
    }

    if (!input.deployedAt) {
      return null;
    }

    const params = new URLSearchParams({
      per_page: "100",
      sha: input.branch,
      since: input.deployedAt,
    });
    const commits = await this.request<GitHubCommitListItemResponse[]>(
      `${this.repoApiPath()}/commits?${params}`,
      token
    );
    return {
      aheadBy: commits.length,
      latestCommitSha: commits[0]?.sha ?? null,
      method: "since-date",
      status: commits.length > 0 ? "ahead" : "identical",
      url: commits[0]?.html_url ?? null,
    };
  }

  private async enrichDevelopmentInfoWithToken(
    info: JiraDevelopmentInfo,
    token: string
  ): Promise<JiraDevelopmentInfo> {
    if (info.pullRequests.length === 0) {
      return info;
    }

    const pullRequests = await Promise.all(
      info.pullRequests.map((pullRequest) =>
        this.enrichPullRequest(pullRequest, token).catch(() => pullRequest)
      )
    );

    return { ...info, pullRequests };
  }

  private async discoverDevelopmentInfoWithToken(
    ticketKey: string,
    token: string
  ): Promise<JiraDevelopmentInfo> {
    if (!ticketKey) {
      return emptyDevelopmentInfo();
    }

    const errors: string[] = [];
    const branches = await this.searchBranches(ticketKey, token).catch(
      (error) => {
        errors.push(
          `GitHub branch search failed: ${githubErrorMessage(error)}`
        );
        return [];
      }
    );

    const [titlePullRequests, branchPullResults] = await Promise.all([
      this.searchPullRequestsByTitle(ticketKey, token).catch((error) => {
        errors.push(
          `GitHub PR title search failed: ${githubErrorMessage(error)}`
        );
        return [];
      }),
      Promise.allSettled(
        branches
          .slice(0, GITHUB_DISCOVERY_LIMIT)
          .map((branch) => this.pullRequestsForBranch(branch.name, token))
      ),
    ]);

    const branchPullRequests: PullRequestSummary[] = [];
    for (const result of branchPullResults) {
      if (result.status === "fulfilled") {
        branchPullRequests.push(...result.value);
      } else {
        errors.push(
          `GitHub PR branch search failed: ${githubErrorMessage(result.reason)}`
        );
      }
    }

    const discoveredPullRequests = uniqueBy(
      [...branchPullRequests, ...titlePullRequests],
      pullRequestKey
    ).slice(0, GITHUB_DISCOVERY_LIMIT);
    const pullRequests = await Promise.all(
      discoveredPullRequests.map((pullRequest) =>
        this.enrichPullRequest(pullRequest, token).catch(() => pullRequest)
      )
    );

    return {
      branches,
      buildCount: 0,
      builds: [],
      errors,
      pullRequests: uniqueBy(pullRequests, pullRequestKey),
    };
  }

  private async enrichPullRequest(
    pullRequest: PullRequestSummary,
    token: string
  ): Promise<PullRequestSummary> {
    const number = pullRequestNumber(pullRequest);
    if (!number) {
      return pullRequest;
    }

    const [githubPullRequest, reviews] = await Promise.all([
      this.request<GitHubPullRequestResponse>(
        `${this.repoApiPath()}/pulls/${number}`,
        token
      ),
      this.request<GitHubReviewResponse[]>(
        `${this.repoApiPath()}/pulls/${number}/reviews?per_page=100`,
        token
      ),
    ]);

    return {
      ...pullRequest,
      approved: reviewsApproved(reviews),
      baseRef: githubPullRequest.base?.ref ?? pullRequest.baseRef,
      headRef: githubPullRequest.head?.ref ?? pullRequest.headRef,
      headSha: githubPullRequest.head?.sha ?? pullRequest.headSha,
      isDraft: githubPullRequest.draft ?? pullRequest.isDraft,
      mergedAt: githubPullRequest.merged_at ?? pullRequest.mergedAt,
      number: githubPullRequest.number ?? pullRequest.number,
      source: pullRequest.source === "jira" ? "enriched" : pullRequest.source,
      state: pullRequestState(githubPullRequest, pullRequest.state),
      title: githubPullRequest.title ?? pullRequest.title,
      updatedAt: githubPullRequest.updated_at ?? pullRequest.updatedAt,
      url: githubPullRequest.html_url ?? pullRequest.url,
    };
  }

  private async searchBranches(
    ticketKey: string,
    token: string
  ): Promise<BranchSummary[]> {
    const refs = await this.request<GitHubBranchRefResponse[]>(
      `${this.repoApiPath()}/git/matching-refs/heads/${encodeURIComponent(`${ticketKey}-`)}`,
      token
    );
    const repo = this.repoRef();
    return refs.flatMap((ref) => {
      const name = branchNameFromRef(ref.ref);
      if (!name?.toUpperCase().startsWith(`${ticketKey}-`)) {
        return [];
      }
      return [
        {
          headSha: ref.object?.sha ?? "",
          name,
          source: "github" as const,
          url: githubBranchUrl(repo, name),
        },
      ];
    });
  }

  private async pullRequestsForBranch(
    branch: string,
    token: string
  ): Promise<PullRequestSummary[]> {
    const { owner } = this.config.get().github;
    const params = new URLSearchParams({
      head: `${owner}:${branch}`,
      per_page: String(GITHUB_DISCOVERY_LIMIT),
      state: "all",
    });
    const pullRequests = await this.request<GitHubPullRequestResponse[]>(
      `${this.repoApiPath()}/pulls?${params}`,
      token
    );
    return pullRequests.flatMap((pullRequest) =>
      githubPullRequestToSummary(pullRequest, this.repoRef())
    );
  }

  private async searchPullRequestsByTitle(
    ticketKey: string,
    token: string
  ): Promise<PullRequestSummary[]> {
    const { owner, repo } = this.config.get().github;
    const params = new URLSearchParams({
      per_page: String(GITHUB_DISCOVERY_LIMIT),
      q: `repo:${owner}/${repo} is:pr ${ticketKey} in:title`,
    });
    const response = await this.request<GitHubIssueSearchResponse>(
      `/search/issues?${params}`,
      token
    );
    return (response.items ?? []).flatMap((item) =>
      issueSearchItemToPullRequest(item, this.repoRef())
    );
  }

  private repoApiPath(): string {
    const { owner, repo } = this.config.get().github;
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private repoRef(): { owner: string; repo: string } {
    const { owner, repo } = this.config.get().github;
    return { owner, repo };
  }

  private missingTokenMessage(): string {
    return this.config.get().github.useGhCli
      ? "GitHub fallback skipped: no GitHub token found via gh CLI."
      : "GitHub fallback skipped: no GitHub token configured.";
  }

  private async token(): Promise<string | null> {
    const { useGhCli } = this.config.get().github;
    if (!useGhCli) {
      return this.config.getSecret("githubToken");
    }

    const now = Date.now();
    if (this.ghCliTokenCache && this.ghCliTokenCache.expiresAt > now) {
      return this.ghCliTokenCache.value;
    }

    this.ghCliTokenRequest ??= this.readGhCliToken().finally(() => {
      this.ghCliTokenRequest = null;
    });
    const value = await this.ghCliTokenRequest;
    this.ghCliTokenCache = {
      expiresAt: now + GH_CLI_TOKEN_CACHE_MS,
      value,
    };
    return value;
  }

  private async readGhCliToken(): Promise<string | null> {
    try {
      const { stdout } = await execCli("gh", ["auth", "token"], {
        timeout: 5000,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async request<T>(
    path: string,
    token: string,
    init: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
    if (init.body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${GITHUB_API_BASE}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      throw new Error(await githubResponseMessage(response));
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("GitHub returned an invalid JSON response.");
    }
  }
}

function githubWorkflowRunToSummary(
  run: GitHubWorkflowRunResponse
): GitHubWorkflowRunSummary[] {
  const id = run.id ?? 0;
  if (id <= 0) {
    return [];
  }

  return [
    {
      conclusion: run.conclusion ?? null,
      createdAt: run.created_at ?? "",
      currentAttempt: run.run_attempt ?? 1,
      event: run.event ?? "",
      headBranch: run.head_branch ?? null,
      id,
      status: run.status ?? null,
      updatedAt: run.updated_at ?? "",
      url: run.html_url ?? "",
    },
  ];
}

function githubWorkflowJobToSummary(
  job: GitHubWorkflowJobResponse
): GitHubWorkflowJobSummary[] {
  const id = job.id ?? 0;
  const name = job.name ?? "";
  if (id <= 0 || !name) {
    return [];
  }

  return [
    {
      completedAt: job.completed_at ?? null,
      conclusion: job.conclusion ?? null,
      id,
      name,
      startedAt: job.started_at ?? null,
      status: job.status ?? null,
      url: job.html_url ?? "",
    },
  ];
}

function emptyDevelopmentInfo(errors: string[] = []): JiraDevelopmentInfo {
  return {
    branches: [],
    buildCount: 0,
    builds: [],
    errors,
    pullRequests: [],
  };
}

function appendError(
  info: JiraDevelopmentInfo,
  message: string
): JiraDevelopmentInfo {
  return { ...info, errors: uniqueMessages([...info.errors, message]) };
}

function mergeDevelopmentInfo(
  primary: JiraDevelopmentInfo,
  fallback: JiraDevelopmentInfo,
  includeFallback: { branches: boolean; pullRequests: boolean } = {
    branches: true,
    pullRequests: true,
  }
): JiraDevelopmentInfo {
  return {
    branches: includeFallback.branches
      ? uniqueBy([...primary.branches, ...fallback.branches], (branch) =>
          branch.name.toLowerCase()
        )
      : primary.branches,
    buildCount: primary.buildCount,
    builds: primary.builds,
    errors: uniqueMessages([...primary.errors, ...fallback.errors]),
    pullRequests: includeFallback.pullRequests
      ? mergePullRequests(primary.pullRequests, fallback.pullRequests)
      : primary.pullRequests,
  };
}

function mergePullRequests(
  primary: PullRequestSummary[],
  fallback: PullRequestSummary[]
): PullRequestSummary[] {
  const merged = new Map<string, PullRequestSummary>();

  for (const pullRequest of primary) {
    merged.set(pullRequestKey(pullRequest), pullRequest);
  }

  for (const pullRequest of fallback) {
    const key = pullRequestKey(pullRequest);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, pullRequest);
      continue;
    }
    if (existing.source === "jira") {
      merged.set(key, {
        ...existing,
        approved: existing.approved ?? pullRequest.approved,
        baseRef: existing.baseRef || pullRequest.baseRef,
        headRef: existing.headRef || pullRequest.headRef,
        headSha: existing.headSha ?? pullRequest.headSha,
        isDraft: existing.isDraft || pullRequest.isDraft,
        mergedAt: existing.mergedAt ?? pullRequest.mergedAt,
        number: existing.number || pullRequest.number,
        source: "enriched",
        state: pullRequest.state,
        title: existing.title || pullRequest.title,
        updatedAt: existing.updatedAt ?? pullRequest.updatedAt,
        url: existing.url || pullRequest.url,
      });
    }
  }

  return [...merged.values()];
}

function githubPullRequestToSummary(
  pullRequest: GitHubPullRequestResponse,
  repo: { owner: string; repo: string }
): PullRequestSummary[] {
  const number = pullRequest.number ?? 0;
  if (number <= 0) {
    return [];
  }

  return [
    {
      approved: false,
      baseRef: pullRequest.base?.ref ?? "",
      headRef: pullRequest.head?.ref ?? "",
      headSha: pullRequest.head?.sha ?? null,
      isDraft: pullRequest.draft ?? false,
      mergedAt: pullRequest.merged_at ?? null,
      number,
      source: "github",
      state: pullRequestState(
        pullRequest,
        pullRequest.state === "closed" ? "closed" : "open"
      ),
      title: pullRequest.title ?? `Pull request #${number}`,
      updatedAt: pullRequest.updated_at ?? null,
      url: pullRequest.html_url ?? githubPullRequestUrl(repo, number),
    },
  ];
}

function issueSearchItemToPullRequest(
  item: GitHubIssueSearchItem,
  repo: { owner: string; repo: string }
): PullRequestSummary[] {
  const number = item.number ?? 0;
  if (number <= 0 || !item.pull_request) {
    return [];
  }

  return [
    {
      approved: false,
      baseRef: "",
      headRef: "",
      headSha: null,
      isDraft: false,
      number,
      source: "github",
      state: item.state === "closed" ? "closed" : "open",
      title: item.title ?? `Pull request #${number}`,
      updatedAt: item.updated_at ?? null,
      url: item.html_url ?? githubPullRequestUrl(repo, number),
    },
  ];
}

function branchNameFromRef(ref: string | undefined): string | null {
  if (!ref?.startsWith(GITHUB_BRANCH_REF_PREFIX)) {
    return null;
  }
  return ref.slice(GITHUB_BRANCH_REF_PREFIX.length);
}

function pullRequestNumber(pullRequest: PullRequestSummary): number {
  if (pullRequest.number > 0) {
    return pullRequest.number;
  }

  const match = pullRequest.url.match(GITHUB_PR_NUMBER_PATTERN);
  return match?.[1] ? Number(match[1]) : 0;
}

function pullRequestKey(pullRequest: PullRequestSummary): string {
  if (pullRequest.number > 0) {
    return `number:${pullRequest.number}`;
  }
  return `url:${pullRequest.url.toLowerCase()}`;
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

function uniqueMessages(messages: string[]): string[] {
  return uniqueBy(messages.filter(Boolean), (message) => message);
}

function pullRequestState(
  pullRequest: GitHubPullRequestResponse,
  fallback: PullRequestSummary["state"]
): PullRequestSummary["state"] {
  if (pullRequest.merged_at) {
    return "merged";
  }
  if (pullRequest.state === "closed") {
    return "closed";
  }
  if (pullRequest.state === "open") {
    return "open";
  }
  return fallback;
}

export function reviewsApproved(reviews: GitHubReviewResponse[]): boolean {
  const latestDecisiveReviewByUser = new Map<string, string>();

  for (const review of reviews.toSorted(compareReviews)) {
    const state = review.state?.toUpperCase();
    if (
      !(
        state === "APPROVED" ||
        state === "CHANGES_REQUESTED" ||
        state === "DISMISSED"
      )
    ) {
      continue;
    }

    const user = review.user?.login ?? String(review.user?.id ?? "");
    if (user) {
      latestDecisiveReviewByUser.set(user, state);
    }
  }

  const states = [...latestDecisiveReviewByUser.values()];
  return states.includes("APPROVED") && !states.includes("CHANGES_REQUESTED");
}

function compareReviews(
  a: GitHubReviewResponse,
  b: GitHubReviewResponse
): number {
  return reviewTime(a) - reviewTime(b);
}

function reviewTime(review: GitHubReviewResponse): number {
  const time = review.submitted_at
    ? Date.parse(review.submitted_at)
    : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

async function githubResponseMessage(response: Response): Promise<string> {
  if (response.status === 401 || response.status === 403) {
    return "GitHub authentication failed.";
  }
  if (response.status === 404) {
    return "GitHub repository or pull request was not found.";
  }

  const text = await response.text();
  const detail = githubResponseDetail(text) || response.statusText;
  return detail
    ? `GitHub returned HTTP ${response.status}: ${detail}`
    : `GitHub returned HTTP ${response.status}.`;
}

function githubResponseDetail(text: string): string {
  if (!text) {
    return "";
  }

  try {
    const data = JSON.parse(text) as { message?: unknown };
    return typeof data.message === "string" ? data.message.slice(0, 300) : "";
  } catch {
    return text.replace(/\s+/g, " ").slice(0, 300);
  }
}

function githubErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
