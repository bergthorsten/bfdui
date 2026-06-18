import { ipc } from "@/ipc/manager";
import type {
  AppConfig,
  DeploymentIntentInput,
  WorkflowTargetUsageInput,
} from "@/types/bfd";

export function getBfdConfig() {
  return ipc.client.bfd.getConfig();
}

export function checkBfdEnvironment() {
  return ipc.client.bfd.checkEnvironment();
}

export function getSprintTickets() {
  return ipc.client.bfd.getSprintTickets();
}

export function getDevDeployments() {
  return ipc.client.bfd.getDevDeployments();
}

export function getWorkflowTargets() {
  return ipc.client.bfd.getWorkflowTargets();
}

export function getTicketDevelopment(input: {
  issueId: string;
  ticketKey: string;
}) {
  return ipc.client.bfd.getTicketDevelopment(input);
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

export function recordWorkflowTargetUsage(input: WorkflowTargetUsageInput) {
  return ipc.client.bfd.recordWorkflowTargetUsage(input);
}

export function createDeployment(input: DeploymentIntentInput) {
  return ipc.client.bfd.createDeployment(input);
}

export function getDeploymentBatches() {
  return ipc.client.bfd.getDeploymentBatches();
}

export function getDeploymentBatch(id: string) {
  return ipc.client.bfd.getDeploymentBatch({ id });
}

export function refreshDeploymentBatch(id: string) {
  return ipc.client.bfd.refreshDeploymentBatch({ id });
}

export function testBfdConnection(
  kind: "jira" | "github" | "argo" | "repo",
  draft?: {
    config: AppConfig;
    secrets?: {
      githubToken?: string;
      jiraToken?: string;
    };
  }
) {
  return ipc.client.bfd.testConnection({ kind, ...draft });
}
