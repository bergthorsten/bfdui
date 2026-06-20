import type { ConfigService } from "@/services/config";
import {
  type DevStatusDataType,
  type DevStatusDetail,
  type DevStatusDetailResponse,
  type DevStatusSummaryResponse,
  type DevStatusTarget,
  detailPullRequests,
  developmentInfoFromSettledDetails,
  devStatusTargetsFromSummary,
  fallbackDevelopmentTargets,
} from "@/services/jira-dev-status";
import { jiraErrorMessage, messageOf } from "@/services/jira-error";
import type {
  ConnectionResult,
  JiraDevelopmentInfo,
  JiraSprint,
  JiraStatusCategory,
  JiraTicket,
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
    assignee?: { displayName?: string; avatarUrls?: Record<string, string> };
    status?: { name: string };
    summary: string;
    updated?: string;
    [fieldId: string]: unknown;
  };
  id: string;
  key: string;
}

interface JiraSearchResponse {
  isLast?: boolean;
  issues: JiraIssue[];
  nextPageToken?: string;
}

interface JiraField {
  id: string;
  name?: string;
  schema?: {
    custom?: string;
  };
}

interface JiraSprintFieldValue {
  endDate?: string;
  goal?: string;
  id?: number | string;
  name?: string;
  startDate?: string;
  state?: string;
}

const PAGE_SIZE = 50;
const MAX_PAGES = 20; // safety bound
const GLOBAL_SEARCH_PAGE_SIZE = 25;
const TRAILING_SLASHES_PATTERN = /\/+$/;
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
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

  async getActiveSprint(jql: string): Promise<JiraSprint | null> {
    const sprintFieldId = await this.sprintFieldId();
    if (!sprintFieldId) {
      return null;
    }

    const sprintsById = new Map<
      number,
      { issueCount: number; sprint: JiraSprint }
    >();
    let nextPageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${this.baseUrl()}/rest/api/3/search/jql`);
      url.searchParams.set("jql", jql);
      url.searchParams.set("maxResults", String(PAGE_SIZE));
      url.searchParams.set("fields", sprintFieldId);
      if (nextPageToken) {
        url.searchParams.set("nextPageToken", nextPageToken);
      }

      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) {
        throw new Error(await jiraErrorMessage(res));
      }

      const data = (await res.json()) as JiraSearchResponse;
      for (const issue of data.issues) {
        for (const sprint of sprintsFromFieldValue(
          issue.fields[sprintFieldId]
        )) {
          if (sprint.state.toLowerCase() !== "active") {
            continue;
          }
          const current = sprintsById.get(sprint.id);
          sprintsById.set(sprint.id, {
            sprint,
            issueCount: (current?.issueCount ?? 0) + 1,
          });
        }
      }

      nextPageToken = data.nextPageToken;
      if (data.issues.length === 0 || data.isLast || !nextPageToken) {
        break;
      }
    }

    const [activeSprint] = [...sprintsById.values()].sort(compareSprintMatches);

    return activeSprint?.sprint ?? null;
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

    const info = developmentInfoFromSettledDetails(details);

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
    const targets = devStatusTargetsFromSummary(data);

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

  private async sprintFieldId(): Promise<string | null> {
    const res = await fetch(`${this.baseUrl()}/rest/api/3/field`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(await jiraErrorMessage(res));
    }

    const fields = (await res.json()) as JiraField[];
    return (
      fields.find(
        (field) =>
          field.schema?.custom === "com.pyxis.greenhopper.jira:gh-sprint"
      )?.id ??
      fields.find((field) => field.name === "Sprint")?.id ??
      null
    );
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

function jqlString(value: string): string {
  return `"${value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim()}"`;
}

function sprintsFromFieldValue(value: unknown): JiraSprint[] {
  if (Array.isArray(value)) {
    return value.flatMap(sprintsFromFieldValue);
  }
  if (typeof value === "string") {
    return sprintFromLegacyString(value);
  }
  if (!(value && typeof value === "object")) {
    return [];
  }

  const sprint = value as JiraSprintFieldValue;
  const id = Number(sprint.id);
  if (!(Number.isFinite(id) && sprint.name)) {
    return [];
  }

  return [toSprint({ ...sprint, id })];
}

function sprintFromLegacyString(value: string): JiraSprint[] {
  const id = Number(legacySprintField(value, "id"));
  const name = legacySprintField(value, "name");
  if (!(Number.isFinite(id) && name)) {
    return [];
  }

  return [
    toSprint({
      endDate: legacySprintField(value, "endDate") ?? undefined,
      goal: legacySprintField(value, "goal") ?? undefined,
      id,
      name,
      startDate: legacySprintField(value, "startDate") ?? undefined,
      state: legacySprintField(value, "state") ?? undefined,
    }),
  ];
}

function legacySprintField(value: string, field: string): string | null {
  const match = value.match(new RegExp(`(?:\\[|,)${field}=([^,\\]]*)`));
  return match?.[1]?.trim() || null;
}

function toSprint(sprint: JiraSprintFieldValue & { id: number }): JiraSprint {
  return {
    endDate: sprint.endDate ?? null,
    goal: sprint.goal ?? "",
    id: sprint.id,
    name: sprint.name ?? "",
    startDate: sprint.startDate ?? null,
    state: sprint.state ?? "",
  };
}

function compareSprintMatches(
  a: { issueCount: number; sprint: JiraSprint },
  b: { issueCount: number; sprint: JiraSprint }
): number {
  return (
    b.issueCount - a.issueCount ||
    dateValue(a.sprint.endDate) - dateValue(b.sprint.endDate)
  );
}

function dateValue(value: string | null): number {
  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
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
