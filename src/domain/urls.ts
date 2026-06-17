import { NUMERIC_ENVIRONMENT_PATTERN } from "@/domain/environments";

export interface GithubRepoRef {
  owner: string;
  repo: string;
}

export const DEFAULT_GITHUB_REPO: GithubRepoRef = {
  owner: "bergfreunde",
  repo: "shop",
};

export function githubRepoUrl(github: GithubRepoRef): string {
  return `https://github.com/${github.owner}/${github.repo}`;
}

export function githubBranchUrl(github: GithubRepoRef, branch: string): string {
  return `${githubRepoUrl(github)}/tree/${encodeURIComponent(branch)}`;
}

export function githubPullRequestUrl(
  github: GithubRepoRef,
  number: number
): string {
  return `${githubRepoUrl(github)}/pull/${number}`;
}

export function devSystemUrl(environment: string): string {
  if (NUMERIC_ENVIRONMENT_PATTERN.test(environment)) {
    return `https://dev-${environment}.bergfreunde.de/`;
  }
  return `https://${environment}.bergfreunde.de/`;
}
