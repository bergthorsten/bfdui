import { ArgoService } from "@/services/argo";
import { ConfigService } from "@/services/config";
import { DeploymentStatusService } from "@/services/deployment-status";
import { DeploymentService } from "@/services/deployments";
import { GitHubService } from "@/services/github";
import { JiraCloudService } from "@/services/jira";
import { WorkflowService } from "@/services/workflows";

export const config = new ConfigService();
export const argo = new ArgoService(config);
export const github = new GitHubService(config);
export const jira = new JiraCloudService(config);
export const workflows = new WorkflowService(config);
export const deployments = new DeploymentService(github, workflows);
export const deploymentStatus = new DeploymentStatusService(argo, github);
