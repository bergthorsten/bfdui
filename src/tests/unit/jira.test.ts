import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConfigService } from "@/services/config";
import { categorizeStatus, JiraCloudService } from "@/services/jira";

const APP_CONFIG = {
  argo: { app: "shop", devContext: "dev" },
  github: { owner: "bergfreunde", repo: "shop", useGhCli: true },
  jira: {
    baseUrl: "https://jira.example.com/",
    email: "user@example.com",
    project: "PC",
    sprintJql: "project = PC",
  },
  onboardingComplete: true,
  repoPath: "/tmp/shop",
};

function configService(token: string | null = "jira-token"): ConfigService {
  return {
    get: () => structuredClone(APP_CONFIG),
    getSecret: () => token,
  } as unknown as ConfigService;
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init,
  });
}

function issue(key: string, status = "In Progress") {
  return {
    fields: {
      assignee: {
        avatarUrls: { "24x24": "https://avatar.example/24" },
        displayName: "Ada Lovelace",
      },
      status: { name: status },
      summary: `${key} summary`,
      updated: "2026-06-17T12:00:00.000Z",
    },
    id: key.replace(/\D/g, "") || "1",
    key,
  };
}

describe("JiraCloudService", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("categorizes Jira statuses", () => {
    expect(categorizeStatus("Done")).toBe("free");
    expect(categorizeStatus("Backlog")).toBe("backlog");
    expect(categorizeStatus("Review")).toBe("occupied");
    expect(categorizeStatus("Unknown custom status")).toBe("occupied");
  });

  test("reports successful Jira connection details", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ displayName: "Ada" }));

    const result = await new JiraCloudService(configService()).testConnection();

    expect(result).toEqual({
      detail: "Ada",
      message: "Connected to Jira.",
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jira.example.com/rest/api/3/myself",
      {
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from("user@example.com:jira-token").toString("base64")}`,
        },
      }
    );
  });

  test("reports auth, missing site, and sanitized API errors", async () => {
    const service = new JiraCloudService(configService());

    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    await expect(service.testConnection()).resolves.toMatchObject({
      message: "Authentication failed (invalid email or API token).",
      ok: false,
    });

    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(service.testConnection()).resolves.toMatchObject({
      message:
        "Jira site not found at https://jira.example.com. Check the Site URL.",
      ok: false,
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { errorMessages: ["No permission"], errors: { jql: "Bad JQL" } },
        { status: 400 }
      )
    );
    await expect(service.testConnection()).resolves.toMatchObject({
      message: "Jira API error (400): No permission; Bad JQL",
      ok: false,
    });
  });

  test("paginates sprint search and maps tickets", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          issues: [issue("PC-1", "Done")],
          nextPageToken: "next-page",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ issues: [issue("PC-2")], isLast: true })
      );

    const tickets = await new JiraCloudService(configService()).search(
      "project = PC"
    );

    expect(tickets).toMatchObject([
      {
        key: "PC-1",
        statusCategory: "free",
        url: "https://jira.example.com/browse/PC-1",
      },
      {
        key: "PC-2",
        statusCategory: "occupied",
        url: "https://jira.example.com/browse/PC-2",
      },
    ]);

    const secondUrl = new URL(fetchMock.mock.calls[1][0].toString());
    expect(secondUrl.searchParams.get("nextPageToken")).toBe("next-page");
  });

  test("looks up issue keys directly during global search", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(issue("PC-123")));

    const tickets = await new JiraCloudService(
      configService()
    ).searchAccessibleTickets("pc-123");

    expect(tickets).toHaveLength(1);
    expect(new URL(fetchMock.mock.calls[0][0].toString()).pathname).toBe(
      "/rest/api/3/issue/PC-123"
    );
  });

  test("escapes free-text global search JQL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ issues: [] }));

    await new JiraCloudService(configService()).searchAccessibleTickets(
      'broken "quote" \\ slash'
    );

    const url = new URL(fetchMock.mock.calls[0][0].toString());
    expect(url.searchParams.get("jql")).toBe(
      'text ~ "broken quote slash" ORDER BY updated DESC'
    );
    expect(url.searchParams.get("maxResults")).toBe("25");
  });
});
