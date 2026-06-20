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

function configService(
  token: string | null = "jira-token",
  appConfig = APP_CONFIG
): ConfigService {
  return {
    get: () => structuredClone(appConfig),
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

  test("reports missing Jira credentials before calling the API", async () => {
    await expect(
      new JiraCloudService(configService(null)).testConnection()
    ).resolves.toMatchObject({
      message: "No Jira API token configured.",
      ok: false,
    });

    await expect(
      new JiraCloudService(
        configService("jira-token", {
          ...APP_CONFIG,
          jira: { ...APP_CONFIG.jira, email: "" },
        })
      ).testConnection()
    ).resolves.toMatchObject({
      message: "No Jira email configured.",
      ok: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("sanitizes non-JSON Jira error responses", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Bad gateway\nfrom Atlassian", {
        status: 502,
        statusText: "Bad Gateway",
      })
    );

    await expect(
      new JiraCloudService(configService()).search("project = PC")
    ).rejects.toThrow("Jira API error (502): Bad gateway from Atlassian");
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

  test("stops search pagination at the max page safety bound", async () => {
    for (let index = 0; index < 25; index++) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          issues: [issue(`PC-${index + 1}`)],
          nextPageToken: `page-${index + 2}`,
        })
      );
    }

    const tickets = await new JiraCloudService(configService()).search(
      "project = PC"
    );

    expect(tickets).toHaveLength(20);
    expect(fetchMock).toHaveBeenCalledTimes(20);
    const lastUrl = new URL(fetchMock.mock.calls.at(-1)?.[0].toString() ?? "");
    expect(lastUrl.searchParams.get("nextPageToken")).toBe("page-20");
  });

  test("loads active sprint metadata from the configured sprint JQL issues", async () => {
    const selectedSprint = {
      endDate: "2026-06-21T16:00:00.000Z",
      goal: "Our customers can order with Paypal Express without login.",
      id: 7,
      name: "Endgegner PainPal",
      startDate: "2026-06-16T08:00:00.000Z",
      state: "active",
    };
    const otherActiveSprint = {
      endDate: "2026-06-19T16:00:00.000Z",
      goal: "Wrong board",
      id: 3,
      name: "Wrong active sprint",
      startDate: "2026-06-16T08:00:00.000Z",
      state: "active",
    };

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "customfield_10020",
            name: "Sprint",
            schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" },
          },
        ])
      )
      .mockResolvedValueOnce(
        jsonResponse({
          isLast: true,
          issues: [
            {
              fields: { customfield_10020: [selectedSprint] },
              id: "1",
              key: "PC-1",
            },
            {
              fields: { customfield_10020: [otherActiveSprint] },
              id: "2",
              key: "PC-2",
            },
            {
              fields: { customfield_10020: [selectedSprint] },
              id: "3",
              key: "PC-3",
            },
          ],
        })
      );

    const sprint = await new JiraCloudService(configService()).getActiveSprint(
      "sprint in openSprints() AND project = PC ORDER BY rank ASC"
    );

    expect(sprint).toEqual({
      endDate: "2026-06-21T16:00:00.000Z",
      goal: "Our customers can order with Paypal Express without login.",
      id: 7,
      name: "Endgegner PainPal",
      startDate: "2026-06-16T08:00:00.000Z",
      state: "active",
    });

    expect(fetchMock.mock.calls[0][0].toString()).toBe(
      "https://jira.example.com/rest/api/3/field"
    );
    const searchUrl = new URL(fetchMock.mock.calls[1][0].toString());
    expect(searchUrl.pathname).toBe("/rest/api/3/search/jql");
    expect(searchUrl.searchParams.get("fields")).toBe("customfield_10020");
    expect(searchUrl.searchParams.get("jql")).toBe(
      "sprint in openSprints() AND project = PC ORDER BY rank ASC"
    );
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

  test("parses development summary targets, details, and duplicates", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          summary: {
            branch: { byInstanceType: { GitHub: { count: 2 } } },
            build: { byInstanceType: { GitHub: { count: 1 } } },
            pullrequest: { byInstanceType: { GitHub: { count: 2 } } },
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          detail: [
            {
              branches: [
                {
                  lastCommit: { id: "branch-sha" },
                  name: "PC-255-fix-search-a11y",
                  url: "https://github.example/tree/PC-255-fix-search-a11y",
                },
                {
                  lastCommit: { id: "duplicate-sha" },
                  name: "PC-255-fix-search-a11y",
                  url: "https://github.example/tree/PC-255-fix-search-a11y",
                },
              ],
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          detail: [
            {
              pullRequests: [
                {
                  destination: { branch: "master" },
                  id: 4830,
                  lastCommit: { id: "pr-sha" },
                  source: { branch: "PC-255-fix-search-a11y" },
                  status: "OPEN APPROVED",
                  title: "PC-255: Fix search icon a11y",
                  url: "https://github.example/pull/4830",
                },
                {
                  destination: { branch: "master" },
                  id: 4830,
                  source: { branch: "PC-255-fix-search-a11y" },
                  status: "OPEN",
                  title: "duplicate",
                  url: "https://github.example/pull/4830",
                },
              ],
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          detail: [
            {
              builds: [
                {
                  name: "CI / test",
                  status: "SUCCESSFUL",
                  url: "https://github.example/actions/runs/1",
                },
              ],
            },
          ],
        })
      );

    const info = await new JiraCloudService(configService()).getDevelopmentInfo(
      "255"
    );

    expect(info.branches).toEqual([
      {
        headSha: "branch-sha",
        name: "PC-255-fix-search-a11y",
        source: "jira",
        url: "https://github.example/tree/PC-255-fix-search-a11y",
      },
    ]);
    expect(info.pullRequests).toEqual([
      expect.objectContaining({
        approved: true,
        headRef: "PC-255-fix-search-a11y",
        headSha: "pr-sha",
        number: 4830,
        source: "jira",
      }),
    ]);
    expect(info.builds).toEqual([
      {
        name: "CI / test",
        status: "SUCCESSFUL",
        url: "https://github.example/actions/runs/1",
      },
    ]);
    expect(info.buildCount).toBe(1);
    expect(info.errors).toEqual([]);
  });

  test("uses dev-status summary application types for detail requests", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          summary: {
            branch: {
              byInstanceType: {
                "oAuth-com.github.integration.production": { count: 1 },
              },
            },
            pullrequest: {
              byInstanceType: {
                "cloud-providers": { count: 1 },
                GitHub: { count: 0 },
              },
            },
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          detail: [
            {
              branches: [
                {
                  name: "PC-255-fix-search-a11y",
                  url: "https://github.example/tree/PC-255-fix-search-a11y",
                },
              ],
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          detail: [
            {
              pullrequests: [
                {
                  id: "4831",
                  name: "PC-255-fix-search-a11y",
                  status: "DECLINED",
                  url: "https://git.example/reviews/4831",
                },
              ],
            },
          ],
        })
      );

    const info = await new JiraCloudService(configService()).getDevelopmentInfo(
      "255"
    );

    expect(info.branches).toHaveLength(1);
    expect(info.pullRequests).toEqual([
      expect.objectContaining({
        number: 4831,
        state: "closed",
        title: "PC-255-fix-search-a11y",
      }),
    ]);

    const detailUrls = fetchMock.mock.calls
      .slice(1)
      .map((call) => new URL(call[0].toString()));
    expect(
      detailUrls.map((url) => url.searchParams.get("applicationType"))
    ).toEqual(["oAuth-com.github.integration.production", "cloud-providers"]);
    expect(detailUrls.map((url) => url.searchParams.get("dataType"))).toEqual([
      "branch",
      "pullrequest",
    ]);
  });

  test("keeps partial development data when one detail target fails", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          summary: {
            branch: { byInstanceType: { GitHub: { count: 1 } } },
            pullrequest: { byInstanceType: { GitHub: { count: 1 } } },
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          detail: [
            {
              branches: [
                {
                  name: "PC-255-fix-search-a11y",
                  url: "https://github.example/tree/PC-255-fix-search-a11y",
                },
              ],
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ message: "dev-status timeout" }, { status: 504 })
      );

    const info = await new JiraCloudService(configService()).getDevelopmentInfo(
      "255"
    );

    expect(info.branches).toHaveLength(1);
    expect(info.pullRequests).toEqual([]);
    expect(info.errors).toEqual(["Jira API error (504): dev-status timeout"]);
  });
});
