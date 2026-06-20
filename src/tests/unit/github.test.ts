import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConfigService } from "@/services/config";
import { GitHubService, reviewsApproved } from "@/services/github";
import type { JiraDevelopmentInfo, PullRequestSummary } from "@/types/bfd";

const APP_CONFIG = {
  argo: { app: "shop", devContext: "dev" },
  github: { owner: "bergfreunde", repo: "shop", useGhCli: false },
  jira: {
    baseUrl: "https://jira.example.com/",
    email: "user@example.com",
    project: "PC",
    sprintJql: "project = PC",
  },
  onboardingComplete: true,
  repoPath: "/tmp/shop",
};

function configService(token: string | null = "github-token"): ConfigService {
  return {
    get: () => structuredClone(APP_CONFIG),
    getSecret: (key: string) => (key === "githubToken" ? token : null),
  } as unknown as ConfigService;
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init,
  });
}

function pullRequest(overrides: Partial<PullRequestSummary> = {}) {
  return {
    approved: false,
    baseRef: "master",
    headRef: "PC-255-fix-search-a11y",
    headSha: null,
    isDraft: false,
    number: 4830,
    source: "jira" as const,
    state: "open" as const,
    title: "Jira PR title",
    url: "https://github.com/bergfreunde/shop/pull/4830",
    ...overrides,
  } satisfies PullRequestSummary;
}

function developmentInfo(
  pullRequests: PullRequestSummary[]
): JiraDevelopmentInfo {
  return {
    branches: [],
    buildCount: 0,
    builds: [],
    errors: [],
    pullRequests,
  };
}

describe("reviewsApproved", () => {
  test("requires at least one approval and no active change requests", () => {
    expect(
      reviewsApproved([
        {
          state: "APPROVED",
          submitted_at: "2026-06-17T12:00:00Z",
          user: { login: "ada" },
        },
      ])
    ).toBe(true);

    expect(
      reviewsApproved([
        {
          state: "APPROVED",
          submitted_at: "2026-06-17T12:00:00Z",
          user: { login: "ada" },
        },
        {
          state: "CHANGES_REQUESTED",
          submitted_at: "2026-06-17T12:01:00Z",
          user: { login: "grace" },
        },
      ])
    ).toBe(false);

    expect(
      reviewsApproved([
        {
          state: "CHANGES_REQUESTED",
          submitted_at: "2026-06-17T12:00:00Z",
          user: { login: "ada" },
        },
        {
          state: "APPROVED",
          submitted_at: "2026-06-17T12:01:00Z",
          user: { login: "ada" },
        },
      ])
    ).toBe(true);

    expect(
      reviewsApproved([
        {
          state: "APPROVED",
          submitted_at: "2026-06-17T12:00:00Z",
          user: { login: "ada" },
        },
        {
          state: "DISMISSED",
          submitted_at: "2026-06-17T12:01:00Z",
          user: { login: "ada" },
        },
      ])
    ).toBe(false);
  });
});

describe("GitHubService", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("enriches Jira PR summaries with GitHub PR and review state", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          base: { ref: "master" },
          draft: false,
          head: { ref: "PC-255-fix-search-a11y", sha: "abc123" },
          html_url: "https://github.com/bergfreunde/shop/pull/4830",
          number: 4830,
          state: "open",
          title: "PC-255: Fix search icon a11y",
          updated_at: "2026-06-17T12:30:00Z",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            state: "APPROVED",
            submitted_at: "2026-06-17T12:00:00Z",
            user: { login: "ada" },
          },
        ])
      );

    const info = await new GitHubService(configService()).enrichDevelopmentInfo(
      developmentInfo([pullRequest()])
    );

    expect(info.pullRequests[0]).toMatchObject({
      approved: true,
      headSha: "abc123",
      source: "enriched",
      state: "open",
      title: "PC-255: Fix search icon a11y",
      updatedAt: "2026-06-17T12:30:00Z",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/bergfreunde/shop/pulls/4830",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer github-token",
        }),
      })
    );
  });

  test("marks merged PRs from GitHub merged_at", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          draft: false,
          merged_at: "2026-06-17T12:00:00Z",
          number: 4830,
          state: "closed",
        })
      )
      .mockResolvedValueOnce(jsonResponse([]));

    const info = await new GitHubService(configService()).enrichDevelopmentInfo(
      developmentInfo([pullRequest()])
    );

    expect(info.pullRequests[0]).toMatchObject({
      approved: false,
      mergedAt: "2026-06-17T12:00:00Z",
      state: "merged",
    });
  });

  test("keeps Jira-only PR data when no GitHub token is available", async () => {
    const original = pullRequest({ approved: false });

    const info = await new GitHubService(
      configService(null)
    ).enrichDevelopmentInfo(developmentInfo([original]));

    expect(info.pullRequests).toEqual([original]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("keeps Jira-only PR data when GitHub enrichment fails", async () => {
    const original = pullRequest({ approved: false });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: "rate limited" }, { status: 403 })
    );

    const info = await new GitHubService(configService()).enrichDevelopmentInfo(
      developmentInfo([original])
    );

    expect(info.pullRequests).toEqual([original]);
  });

  test("discovers fallback branches and PRs by Jira key in GitHub", async () => {
    fetchMock.mockImplementation((url: string) => {
      const href = String(url);
      if (href.includes("/git/matching-refs/heads/PC-255-")) {
        return Promise.resolve(
          jsonResponse([
            {
              object: { sha: "branch-sha" },
              ref: "refs/heads/PC-255-fix-search-a11y",
            },
          ])
        );
      }
      if (href.includes("/search/issues?")) {
        return Promise.resolve(
          jsonResponse({
            items: [
              {
                html_url: "https://github.com/bergfreunde/shop/pull/4900",
                number: 4900,
                pull_request: {},
                state: "open",
                title: "PC-255 title match",
              },
            ],
          })
        );
      }
      if (href.includes("/pulls?")) {
        return Promise.resolve(
          jsonResponse([
            {
              base: { ref: "master" },
              draft: false,
              head: { ref: "PC-255-fix-search-a11y", sha: "pr-sha" },
              html_url: "https://github.com/bergfreunde/shop/pull/4830",
              number: 4830,
              state: "open",
              title: "PC-255 branch PR",
            },
          ])
        );
      }
      if (href.includes("/pulls/4830/reviews")) {
        return Promise.resolve(
          jsonResponse([
            {
              state: "APPROVED",
              submitted_at: "2026-06-17T12:00:00Z",
              user: { login: "ada" },
            },
          ])
        );
      }
      if (href.includes("/pulls/4900/reviews")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (href.includes("/pulls/4830")) {
        return Promise.resolve(
          jsonResponse({
            base: { ref: "master" },
            draft: false,
            head: { ref: "PC-255-fix-search-a11y", sha: "pr-sha" },
            html_url: "https://github.com/bergfreunde/shop/pull/4830",
            number: 4830,
            state: "open",
            title: "PC-255 branch PR",
          })
        );
      }
      if (href.includes("/pulls/4900")) {
        return Promise.resolve(
          jsonResponse({
            base: { ref: "master" },
            draft: false,
            head: { ref: "PC-255-title-match", sha: "title-sha" },
            html_url: "https://github.com/bergfreunde/shop/pull/4900",
            number: 4900,
            state: "open",
            title: "PC-255 title match",
          })
        );
      }
      throw new Error(`Unexpected GitHub request: ${href}`);
    });

    const info = await new GitHubService(
      configService()
    ).discoverDevelopmentInfo("PC-255");

    expect(info.branches).toEqual([
      {
        headSha: "branch-sha",
        name: "PC-255-fix-search-a11y",
        source: "github",
        url: "https://github.com/bergfreunde/shop/tree/PC-255-fix-search-a11y",
      },
    ]);
    expect(info.pullRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          approved: true,
          headRef: "PC-255-fix-search-a11y",
          number: 4830,
          source: "github",
        }),
        expect.objectContaining({
          headRef: "PC-255-title-match",
          number: 4900,
          source: "github",
        }),
      ])
    );
  });

  test("merges GitHub fallback data without duplicating Jira dev-status results", async () => {
    fetchMock.mockImplementation((url: string) => {
      const href = String(url);
      if (href.includes("/git/matching-refs/heads/PC-255-")) {
        return Promise.resolve(
          jsonResponse([
            {
              object: { sha: "github-branch-sha" },
              ref: "refs/heads/PC-255-fix-search-a11y",
            },
          ])
        );
      }
      if (href.includes("/search/issues?")) {
        return Promise.resolve(jsonResponse({ items: [] }));
      }
      if (href.includes("/pulls?")) {
        return Promise.resolve(
          jsonResponse([
            {
              base: { ref: "master" },
              draft: false,
              head: { ref: "PC-255-fix-search-a11y", sha: "github-pr-sha" },
              html_url: "https://github.com/bergfreunde/shop/pull/4830",
              number: 4830,
              state: "open",
              title: "PC-255 GitHub title",
            },
          ])
        );
      }
      if (href.includes("/pulls/4830/reviews")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (href.includes("/pulls/4830")) {
        return Promise.resolve(
          jsonResponse({
            base: { ref: "master" },
            draft: false,
            head: { ref: "PC-255-fix-search-a11y", sha: "github-pr-sha" },
            html_url: "https://github.com/bergfreunde/shop/pull/4830",
            number: 4830,
            state: "open",
            title: "PC-255 GitHub title",
          })
        );
      }
      throw new Error(`Unexpected GitHub request: ${href}`);
    });

    const info = await new GitHubService(
      configService()
    ).completeDevelopmentInfo("PC-255", {
      branches: [
        {
          headSha: "jira-branch-sha",
          name: "PC-255-fix-search-a11y",
          source: "jira",
          url: "https://jira.example/branch",
        },
      ],
      buildCount: 0,
      builds: [],
      errors: [],
      pullRequests: [pullRequest()],
    });

    expect(info.branches).toHaveLength(1);
    expect(info.branches[0]).toMatchObject({
      headSha: "jira-branch-sha",
      source: "jira",
    });
    expect(info.pullRequests).toHaveLength(1);
    expect(info.pullRequests[0]).toMatchObject({
      headSha: "github-pr-sha",
      number: 4830,
      source: "enriched",
      title: "PC-255 GitHub title",
    });
  });

  test("uses GitHub fallback only for development data categories Jira missed", async () => {
    fetchMock.mockImplementation((url: string) => {
      const href = String(url);
      if (href.includes("/git/matching-refs/heads/PC-255-")) {
        return Promise.resolve(
          jsonResponse([
            {
              object: { sha: "github-branch-sha" },
              ref: "refs/heads/PC-255-fix-search-a11y",
            },
          ])
        );
      }
      if (href.includes("/search/issues?")) {
        return Promise.resolve(jsonResponse({ items: [] }));
      }
      if (href.includes("/pulls?")) {
        return Promise.resolve(
          jsonResponse([
            {
              base: { ref: "master" },
              draft: false,
              head: { ref: "PC-255-fix-search-a11y", sha: "github-pr-sha" },
              html_url: "https://github.com/bergfreunde/shop/pull/4830",
              number: 4830,
              state: "open",
              title: "PC-255 GitHub title",
            },
          ])
        );
      }
      if (href.includes("/pulls/4830/reviews")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (href.includes("/pulls/4830")) {
        return Promise.resolve(
          jsonResponse({
            base: { ref: "master" },
            draft: false,
            head: { ref: "PC-255-fix-search-a11y", sha: "github-pr-sha" },
            html_url: "https://github.com/bergfreunde/shop/pull/4830",
            number: 4830,
            state: "open",
            title: "PC-255 GitHub title",
          })
        );
      }
      throw new Error(`Unexpected GitHub request: ${href}`);
    });

    const info = await new GitHubService(
      configService()
    ).completeDevelopmentInfo("PC-255", {
      branches: [
        {
          headSha: "jira-branch-sha",
          name: "PC-255-fix-search-a11y",
          source: "jira",
          url: "https://jira.example/branch",
        },
      ],
      buildCount: 0,
      builds: [],
      errors: [],
      pullRequests: [],
    });

    expect(info.branches).toEqual([
      {
        headSha: "jira-branch-sha",
        name: "PC-255-fix-search-a11y",
        source: "jira",
        url: "https://jira.example/branch",
      },
    ]);
    expect(info.pullRequests).toEqual([
      expect.objectContaining({
        headSha: "github-pr-sha",
        number: 4830,
        source: "github",
      }),
    ]);
  });

  test("checks repository access", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ default_branch: "master", full_name: "bergfreunde/shop" })
    );

    await expect(
      new GitHubService(configService()).testConnection()
    ).resolves.toEqual({
      detail: "bergfreunde/shop · master",
      message: "Connected to GitHub.",
      ok: true,
    });
  });

  test("dispatches workflows and lists workflow_dispatch runs", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse({
          workflow_runs: [
            {
              conclusion: null,
              created_at: "2026-06-18T10:00:01Z",
              event: "workflow_dispatch",
              head_branch: "PC-123-shop",
              html_url: "https://github.com/bergfreunde/shop/actions/runs/123",
              id: 123,
              run_attempt: 1,
              status: "queued",
              updated_at: "2026-06-18T10:00:02Z",
            },
          ],
        })
      );

    const service = new GitHubService(configService());
    await service.dispatchWorkflow({
      inputs: { ENVIRONMENT: "04", PERFORM_TESTS: "true" },
      ref: "PC-123-shop",
      workflowFileName: "app-shop.yml",
    });
    const runs = await service.listWorkflowRuns({
      branch: "PC-123-shop",
      createdAfter: Date.parse("2026-06-18T09:59:30Z"),
      workflowFileName: "app-shop.yml",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/bergfreunde/shop/actions/workflows/app-shop.yml/dispatches",
      expect.objectContaining({
        body: JSON.stringify({
          inputs: { ENVIRONMENT: "04", PERFORM_TESTS: "true" },
          ref: "PC-123-shop",
        }),
        method: "POST",
      })
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      "/actions/workflows/app-shop.yml/runs?"
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      "event=workflow_dispatch"
    );
    expect(runs).toEqual([
      {
        conclusion: null,
        createdAt: "2026-06-18T10:00:01Z",
        currentAttempt: 1,
        event: "workflow_dispatch",
        headBranch: "PC-123-shop",
        id: 123,
        status: "queued",
        updatedAt: "2026-06-18T10:00:02Z",
        url: "https://github.com/bergfreunde/shop/actions/runs/123",
      },
    ]);
  });
});
