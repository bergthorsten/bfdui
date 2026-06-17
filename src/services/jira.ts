import type { ConfigService } from "@/services/config";
import type {
  BranchSummary,
  BuildSummary,
  ConnectionResult,
  JiraDevelopmentInfo,
  JiraStatusCategory,
  JiraTicket,
  PullRequestSummary,
} from "@/types/bfd";

// Status buckets mirrored from bf-deploy/src/common/constants.py so the
// dashboard colors match the CLI's notion of free/occupied systems.
const STATUS_FREE = new Set([
  "-",
  "Fertig",
  "Done",
  "Awaiting go live",
  "Erledigt",
]);
const STATUS_BACKLOG = new Set(["Backlog", "Selected for Development"]);
const STATUS_OCCUPIED = new Set([
  "In Arbeit",
  "In Progress",
  "In Testing",
  "Review",
  "Acceptance Test",
  "Awaiting testing",
]);

interface JiraIssue {
  fields: {
    summary: string;
    status?: { name: string };
    assignee?: { displayName?: string; avatarUrls?: Record<string, string> };
    updated?: string;
  };
  id: string;
  key: string;
}

interface JiraSearchResponse {
  isLast?: boolean;
  issues: JiraIssue[];
  nextPageToken?: string;
}

interface DevStatusDetailResponse {
  detail?: DevStatusDetail[];
  errors?: unknown[];
}

interface DevStatusSummaryResponse {
  summary?: Partial<Record<DevStatusDataType, DevStatusSummaryData>>;
}

interface DevStatusSummaryData {
  byInstanceType?: Record<string, { count?: number; name?: string }>;
  overall?: { count?: number; dataType?: string; lastUpdated?: string | null };
}

type DevStatusDataType = "branch" | "build" | "pullrequest";

interface DevStatusTarget {
  applicationType: string;
  dataType: DevStatusDataType;
}

interface DevStatusDetail {
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

const PAGE_SIZE = 50;
const MAX_PAGES = 20; // safety bound
const GLOBAL_SEARCH_PAGE_SIZE = 25;
const TRAILING_SLASHES_PATTERN = /\/+$/;
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
const GITHUB_PR_NUMBER_PATTERN = /\/pull\/(\d+)/;
const JIRA_DEV_DEBUG = process.env.BFD_JIRA_DEV_DEBUG === "1";

export function categorizeStatus(status: string): JiraStatusCategory {
  if (STATUS_FREE.has(status)) {
    return "free";
  }
  if (STATUS_BACKLOG.has(status)) {
    return "backlog";
  }
  if (STATUS_OCCUPIED.has(status)) {
    return "occupied";
  }
  return "occupied"; // bf-deploy defaults unknown statuses to occupied
}

export class JiraCloudService {
  private readonly config: Pick<ConfigService, "get" | "getSecret">;

  constructor(config: Pick<ConfigService, "get" | "getSecret">) {
    this.config = config;
  }

  private baseUrl(): string {
    return this.config.get().jira.baseUrl.replace(TRAILING_SLASHES_PATTERN, "");
  }

  private headers(): Record<string, string> {
    const { email } = this.config.get().jira;
    const token = this.config.getSecret("jiraToken");
    if (!email) {
      throw new Error("No Jira email configured.");
    }
    if (!token) {
      throw new Error("No Jira API token configured.");
    }
    const credentials = Buffer.from(`${email}:${token}`, "utf8").toString(
      "base64"
    );
    return {
      Accept: "application/json",
      Authorization: `Basic ${credentials}`,
    };
  }

  ticketUrl(key: string): string {
    return `${this.baseUrl()}/browse/${key}`;
  }

  private toTicket(issue: JiraIssue): JiraTicket {
    const statusName = issue.fields.status?.name ?? "N/A";
    const avatars = issue.fields.assignee?.avatarUrls ?? {};
    return {
      key: issue.key,
      id: issue.id,
      title: issue.fields.summary ?? "",
      status: statusName,
      statusCategory: categorizeStatus(statusName),
      assignee: issue.fields.assignee?.displayName ?? null,
      assigneeAvatar: avatars["24x24"] ?? avatars["48x48"] ?? null,
      updated: issue.fields.updated ?? null,
      url: this.ticketUrl(issue.key),
    };
  }

  async testConnection(): Promise<ConnectionResult> {
    try {
      const res = await fetch(`${this.baseUrl()}/rest/api/3/myself`, {
        headers: this.headers(),
      });
      if (res.status === 401) {
        return {
          ok: false,
          message: "Authentication failed (invalid email or API token).",
        };
      }
      if (res.status === 404) {
        return {
          ok: false,
          message: `Jira site not found at ${this.baseUrl()}. Check the Site URL.`,
        };
      }
      if (!res.ok) {
        return { ok: false, message: await jiraErrorMessage(res) };
      }
      const me = (await res.json()) as {
        accountId?: string;
        displayName?: string;
        emailAddress?: string;
      };
      return {
        ok: true,
        message: "Connected to Jira.",
        detail: me.displayName ?? me.emailAddress ?? me.accountId,
      };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }

  async search(jql: string): Promise<JiraTicket[]> {
    const tickets: JiraTicket[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${this.baseUrl()}/rest/api/3/search/jql`);
      url.searchParams.set("jql", jql);
      url.searchParams.set("maxResults", String(PAGE_SIZE));
      url.searchParams.set("fields", "summary,status,assignee,updated");
      if (nextPageToken) {
        url.searchParams.set("nextPageToken", nextPageToken);
      }
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) {
        throw new Error(await jiraErrorMessage(res));
      }
      const data = (await res.json()) as JiraSearchResponse;
      for (const issue of data.issues) {
        tickets.push(this.toTicket(issue));
      }
      nextPageToken = data.nextPageToken;
      if (data.issues.length === 0 || data.isLast || !nextPageToken) {
        break;
      }
    }
    return tickets;
  }

  async searchAccessibleTickets(query: string): Promise<JiraTicket[]> {
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }

    const maybeKey = normalized.toUpperCase();
    if (ISSUE_KEY_PATTERN.test(maybeKey)) {
      const ticket = await this.getTicket(maybeKey);
      return ticket ? [ticket] : [];
    }

    return this.searchPage(
      `text ~ ${jqlString(normalized)} ORDER BY updated DESC`,
      GLOBAL_SEARCH_PAGE_SIZE
    );
  }

  async getDevelopmentInfo(issueId: string): Promise<JiraDevelopmentInfo> {
    jiraDevLog(`fetching development info for issue ${issueId}`);

    const targets = await this.developmentTargets(issueId);

    const detailRequests = targets.map((target) =>
      this.developmentDetail(issueId, target.dataType, target.applicationType)
    );
    const details = await Promise.allSettled(detailRequests);

    const errors = details
      .filter((result) => result.status === "rejected")
      .map((result) => messageOf(result.reason));
    const allDetails = details.flatMap(detailValue);

    const info = {
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

    jiraDevLog(`parsed development info for issue ${issueId}`, {
      branches: info.branches.length,
      builds: info.buildCount,
      errors: info.errors.length,
      pullRequests: info.pullRequests.length,
    });

    return info;
  }

  private async developmentDetail(
    issueId: string,
    dataType: DevStatusDataType,
    applicationType: string
  ): Promise<DevStatusDetail[]> {
    const url = new URL(
      `${this.baseUrl()}/rest/dev-status/latest/issue/detail`
    );
    url.searchParams.set("issueId", issueId);
    url.searchParams.set("applicationType", applicationType);
    url.searchParams.set("dataType", dataType);

    const res = await fetch(url, { headers: this.headers() });
    jiraDevLog(
      `${applicationType}/${dataType} detail response for issue ${issueId}`,
      {
        status: res.status,
        ok: res.ok,
      }
    );

    if (!res.ok) {
      const message = await jiraErrorMessage(res);
      jiraDevWarn(
        `${applicationType}/${dataType} detail failed for issue ${issueId}`,
        {
          message,
        }
      );
      throw new Error(message);
    }

    const data = (await res.json()) as DevStatusDetailResponse;
    const detail = data.detail ?? [];
    jiraDevLog(
      `${applicationType}/${dataType} detail payload for issue ${issueId}`,
      {
        detailCount: detail.length,
        firstDetailKeys: Object.keys(detail[0] ?? {}),
        branchCount: detail.reduce(
          (count, item) => count + (item.branches?.length ?? 0),
          0
        ),
        buildCount: detail.reduce(
          (count, item) => count + (item.builds?.length ?? 0),
          0
        ),
        pullRequestCount: detail.reduce(
          (count, item) => count + detailPullRequests(item).length,
          0
        ),
      }
    );
    return detail;
  }

  private async developmentTargets(
    issueId: string
  ): Promise<DevStatusTarget[]> {
    const url = new URL(
      `${this.baseUrl()}/rest/dev-status/latest/issue/summary`
    );
    url.searchParams.set("issueId", issueId);

    const res = await fetch(url, { headers: this.headers() });
    jiraDevLog(`summary response for issue ${issueId}`, {
      status: res.status,
      ok: res.ok,
    });

    if (!res.ok) {
      jiraDevWarn(`summary failed for issue ${issueId}`, {
        message: await jiraErrorMessage(res),
      });
      return fallbackDevelopmentTargets();
    }

    const data = (await res.json()) as DevStatusSummaryResponse;
    const summary = data.summary ?? {};
    const targets: DevStatusTarget[] = [];

    for (const dataType of ["branch", "pullrequest", "build"] as const) {
      const byInstanceType = summary[dataType]?.byInstanceType ?? {};
      for (const [applicationType, instance] of Object.entries(
        byInstanceType
      )) {
        if ((instance.count ?? 0) > 0) {
          targets.push({ applicationType, dataType });
        }
      }
    }

    jiraDevLog(`summary payload for issue ${issueId}`, {
      targets,
      summaryKeys: Object.keys(summary),
      branchInstances: Object.keys(summary.branch?.byInstanceType ?? {}),
      pullRequestInstances: Object.keys(
        summary.pullrequest?.byInstanceType ?? {}
      ),
      buildInstances: Object.keys(summary.build?.byInstanceType ?? {}),
    });

    return targets.length > 0 ? targets : fallbackDevelopmentTargets();
  }

  private async searchPage(
    jql: string,
    pageSize: number
  ): Promise<JiraTicket[]> {
    const url = new URL(`${this.baseUrl()}/rest/api/3/search/jql`);
    url.searchParams.set("jql", jql);
    url.searchParams.set("maxResults", String(pageSize));
    url.searchParams.set("fields", "summary,status,assignee,updated");

    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(await jiraErrorMessage(res));
    }

    const data = (await res.json()) as JiraSearchResponse;
    return data.issues.map((issue) => this.toTicket(issue));
  }

  async getTicket(key: string): Promise<JiraTicket | null> {
    const url = new URL(`${this.baseUrl()}/rest/api/3/issue/${key}`);
    url.searchParams.set("fields", "summary,status,assignee,updated");
    const res = await fetch(url, { headers: this.headers() });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(await jiraErrorMessage(res));
    }
    return this.toTicket((await res.json()) as JiraIssue);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jqlString(value: string): string {
  return `"${value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim()}"`;
}

function detailValue(
  result: PromiseSettledResult<DevStatusDetail[]>
): DevStatusDetail[] {
  return result.status === "fulfilled" ? result.value : [];
}

function branchToSummary(branch: DevStatusBranch): BranchSummary[] {
  if (!(branch.name && branch.url)) {
    return [];
  }
  return [
    {
      name: branch.name,
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

function detailPullRequests(detail: DevStatusDetail): DevStatusPullRequest[] {
  return detail.pullRequests ?? detail.pullrequests ?? [];
}

function fallbackDevelopmentTargets(): DevStatusTarget[] {
  return (["branch", "pullrequest", "build"] as const).map((dataType) => ({
    applicationType: "GitHub",
    dataType,
  }));
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

function jiraDevLog(message: string, data?: unknown): void {
  if (!JIRA_DEV_DEBUG) {
    return;
  }
  if (data === undefined) {
    console.info(`[jira-dev] ${message}`);
    return;
  }
  console.info(`[jira-dev] ${message}`, data);
}

function jiraDevWarn(message: string, data?: unknown): void {
  if (!JIRA_DEV_DEBUG) {
    return;
  }
  if (data === undefined) {
    console.warn(`[jira-dev] ${message}`);
    return;
  }
  console.warn(`[jira-dev] ${message}`, data);
}

async function jiraErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  const detail = sanitizedJiraMessage(text) || res.statusText;
  return detail
    ? `Jira API error (${res.status}): ${detail}`
    : `Jira API error (${res.status}).`;
}

function sanitizedJiraMessage(text: string): string {
  if (!text) {
    return "";
  }

  try {
    const data = JSON.parse(text) as {
      errorMessages?: unknown;
      errors?: unknown;
      message?: unknown;
    };
    const messages = Array.isArray(data.errorMessages)
      ? data.errorMessages.map(String)
      : [];
    if (data.errors && typeof data.errors === "object") {
      messages.push(...Object.values(data.errors).map(String));
    }
    if (typeof data.message === "string") {
      messages.push(data.message);
    }
    return messages.join("; ").slice(0, 500);
  } catch {
    return text.replace(/\s+/g, " ").slice(0, 300);
  }
}
