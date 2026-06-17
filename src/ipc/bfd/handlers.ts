import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { os } from "@orpc/server";
import { ArgoService } from "@/services/argo";
import { ConfigService } from "@/services/config";
import { JiraCloudService } from "@/services/jira";
import type { ConnectionResult } from "@/types/bfd";
import {
  getTicketDevelopmentInputSchema,
  saveConfigInputSchema,
  searchTicketsInputSchema,
  testConnectionInputSchema,
} from "./schemas";

const execFileAsync = promisify(execFile);
const config = new ConfigService();
const argo = new ArgoService(config);
const jira = new JiraCloudService(config);

export const getConfig = os.handler(() => ({
  config: config.get(),
  secrets: config.secretStatus(),
}));

export const saveConfig = os
  .input(saveConfigInputSchema)
  .handler(({ input }) => {
    const updated = config.update(input.config);
    const secrets = input.secrets;

    if (secrets?.clearJiraToken) {
      config.clearSecret("jiraToken");
    } else if (secrets?.jiraToken) {
      config.setSecret("jiraToken", secrets.jiraToken);
    }

    if (secrets?.clearGithubToken) {
      config.clearSecret("githubToken");
    } else if (secrets?.githubToken) {
      config.setSecret("githubToken", secrets.githubToken);
    }

    return { config: updated, secrets: config.secretStatus() };
  });

export const testConnection = os
  .input(testConnectionInputSchema)
  .handler(({ input }) => {
    switch (input) {
      case "jira":
        return jira.testConnection();
      case "github":
        return testGithubConnection();
      case "argo":
        return argo.testConnection();
      case "repo":
        return testRepoConnection();
      default:
        return { ok: false, message: "Unknown connection type." };
    }
  });

export const getSprintTickets = os.handler(() => {
  const { sprintJql } = config.get().jira;
  return jira.search(sprintJql);
});

export const searchTickets = os
  .input(searchTicketsInputSchema)
  .handler(({ input }) => jira.searchAccessibleTickets(input.query));

export const getTicketDevelopment = os
  .input(getTicketDevelopmentInputSchema)
  .handler(({ input }) => jira.getDevelopmentInfo(input.issueId));

export const getDevDeployments = os.handler(() => argo.getDevDeployments());

async function testGithubConnection(): Promise<ConnectionResult> {
  const { github } = config.get();

  try {
    const token = github.useGhCli
      ? await githubCliToken()
      : config.getSecret("githubToken");
    if (!token) {
      return {
        ok: false,
        message: github.useGhCli
          ? "No GitHub token found via gh CLI."
          : "No GitHub token configured.",
      };
    }

    const res = await fetch(
      `https://api.github.com/repos/${github.owner}/${github.repo}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "GitHub authentication failed." };
    }
    if (res.status === 404) {
      return { ok: false, message: "GitHub repository was not found." };
    }
    if (!res.ok) {
      return { ok: false, message: `GitHub returned HTTP ${res.status}.` };
    }

    const repo = (await res.json()) as {
      default_branch?: string;
      full_name?: string;
    };
    return {
      ok: true,
      message: "Connected to GitHub.",
      detail: `${repo.full_name ?? `${github.owner}/${github.repo}`} · ${repo.default_branch ?? "default branch unknown"}`,
    };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

async function githubCliToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      timeout: 5000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function testRepoConnection(): ConnectionResult {
  const repoPath = expandHome(config.get().repoPath);
  const workflowsPath = path.join(repoPath, ".github", "workflows");

  if (!existsSync(repoPath)) {
    return { ok: false, message: "Repository path does not exist." };
  }

  if (!statSync(repoPath).isDirectory()) {
    return { ok: false, message: "Repository path is not a directory." };
  }

  if (!(existsSync(workflowsPath) && statSync(workflowsPath).isDirectory())) {
    return {
      ok: false,
      message: "No .github/workflows directory found in this checkout.",
    };
  }

  return {
    ok: true,
    message: "Local checkout found.",
    detail: workflowsPath,
  };
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
