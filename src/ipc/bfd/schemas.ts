import { z } from "zod";

export const appConfigSchema = z.object({
  argo: z.object({
    app: z.string(),
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

export const getTicketDevelopmentInputSchema = z.object({
  issueId: z.string().trim().min(1),
});

export const testConnectionInputSchema = z.enum([
  "jira",
  "github",
  "argo",
  "repo",
]);
