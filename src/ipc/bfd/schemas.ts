import { z } from "zod";

export const appConfigSchema = z.object({
  argo: z.object({
    app: z.string(),
    argocdNamespace: z.string(),
    devContext: z.string(),
  }),
  github: z.object({
    owner: z.string(),
    repo: z.string(),
    useGhCli: z.boolean(),
  }),
  jira: z.object({
    baseUrl: z.string(),
    email: z.string(),
    project: z.string(),
    sprintJql: z.string(),
  }),
  onboardingComplete: z.boolean(),
  repoPath: z.string(),
});

export const saveConfigInputSchema = z.object({
  config: appConfigSchema,
  secrets: z
    .object({
      clearGithubToken: z.boolean().optional(),
      clearJiraToken: z.boolean().optional(),
      githubToken: z.string().optional(),
      jiraToken: z.string().optional(),
    })
    .optional(),
});

export const searchTicketsInputSchema = z.object({
  query: z.string().trim().min(2),
});

export const setArgoAutoSyncInputSchema = z.object({
  enabled: z.boolean(),
  environment: z.string().trim().min(1),
});

export const getTicketDevelopmentInputSchema = z.object({
  issueId: z.string().trim().min(1),
  ticketKey: z.string().trim().min(1),
});

export const recordWorkflowTargetUsageInputSchema = z.object({
  branch: z.string().trim().min(1).optional(),
  environment: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  ticketKey: z.string().trim().min(1).optional(),
});

export const deploymentWorkflowInputSchema = z.object({
  inputs: z.record(z.string(), z.string()),
  name: z.string().trim().min(1),
  path: z.string().trim().min(1).optional(),
});

export const createDeploymentInputSchema = z.object({
  branch: z.string().trim().min(1),
  environment: z.string().trim().min(1),
  sourceCommitSha: z.string().trim().min(1).optional(),
  ticketKey: z.string().trim().min(1).optional(),
  workflows: z.array(deploymentWorkflowInputSchema).min(1),
});

export const deploymentBatchInputSchema = z.object({
  id: z.string().trim().min(1),
});

export const connectionKindSchema = z.enum(["jira", "github", "argo", "repo"]);

export const testConnectionInputSchema = z.object({
  config: appConfigSchema.optional(),
  kind: connectionKindSchema,
  secrets: z
    .object({
      githubToken: z.string().optional(),
      jiraToken: z.string().optional(),
    })
    .optional(),
});
