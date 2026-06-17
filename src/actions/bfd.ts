import { ipc } from "@/ipc/manager";
import type { AppConfig } from "@/types/bfd";

export function getBfdConfig() {
  return ipc.client.bfd.getConfig();
}

export function getSprintTickets() {
  return ipc.client.bfd.getSprintTickets();
}

export function getDevDeployments() {
  return ipc.client.bfd.getDevDeployments();
}

export function getTicketDevelopment(issueId: string) {
  return ipc.client.bfd.getTicketDevelopment({ issueId });
}

export function searchTickets(query: string) {
  return ipc.client.bfd.searchTickets({ query });
}

export function saveBfdConfig(input: {
  config: AppConfig;
  secrets?: {
    clearGithubToken?: boolean;
    clearJiraToken?: boolean;
    githubToken?: string;
    jiraToken?: string;
  };
}) {
  return ipc.client.bfd.saveConfig(input);
}

export function testBfdConnection(kind: "jira" | "github" | "argo" | "repo") {
  return ipc.client.bfd.testConnection(kind);
}
