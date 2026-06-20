import { useEffect, useState } from "react";
import { getBfdConfig, saveBfdConfig, testBfdConnection } from "@/actions/bfd";
import type { AppConfig, ConnectionResult, SecretStatus } from "@/types/bfd";

export type ConnectionKind = "jira" | "github" | "argo" | "repo";

const EMPTY_SECRET_STATUS: SecretStatus = {
  githubToken: false,
  jiraToken: false,
};

export function useSettingsForm() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [secrets, setSecrets] = useState<SecretStatus>(EMPTY_SECRET_STATUS);
  const [jiraToken, setJiraToken] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<ConnectionResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const initial = await getBfdConfig();
        if (!cancelled) {
          setConfig(initial.config);
          setSecrets(initial.secrets);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  function updateConfig(patch: Partial<AppConfig>) {
    setConfig((current) => (current ? { ...current, ...patch } : current));
    setSaveResult(null);
  }

  function updateJira(patch: Partial<AppConfig["jira"]>) {
    setConfig((current) =>
      current ? { ...current, jira: { ...current.jira, ...patch } } : current
    );
    setSaveResult(null);
  }

  function updateGithub(patch: Partial<AppConfig["github"]>) {
    setConfig((current) =>
      current
        ? { ...current, github: { ...current.github, ...patch } }
        : current
    );
    setSaveResult(null);
  }

  function updateArgo(patch: Partial<AppConfig["argo"]>) {
    setConfig((current) =>
      current ? { ...current, argo: { ...current.argo, ...patch } } : current
    );
    setSaveResult(null);
  }

  async function persist(options?: {
    clearGithubToken?: boolean;
    clearJiraToken?: boolean;
    markComplete?: boolean;
  }) {
    if (!config) {
      throw new Error("Settings have not loaded yet.");
    }

    setSaving(true);
    const nextConfig = {
      ...config,
      onboardingComplete: options?.markComplete
        ? true
        : config.onboardingComplete,
    };

    try {
      const saved = await saveBfdConfig({
        config: nextConfig,
        secrets: {
          clearGithubToken: options?.clearGithubToken,
          clearJiraToken: options?.clearJiraToken,
          githubToken: githubToken.trim() || undefined,
          jiraToken: jiraToken.trim() || undefined,
        },
      });
      setConfig(saved.config);
      setSecrets(saved.secrets);
      setGithubToken("");
      setJiraToken("");
      return saved;
    } finally {
      setSaving(false);
    }
  }

  async function saveSettings() {
    try {
      const saved = await persist({ markComplete: true });
      setSaveResult({
        ok: !saved.warning,
        message: saved.warning ?? "Settings saved.",
      });
    } catch (error) {
      setSaveResult({ ok: false, message: messageOf(error) });
    }
  }

  async function clearSecret(kind: "jira" | "github") {
    await persist({
      clearGithubToken: kind === "github",
      clearJiraToken: kind === "jira",
    });
  }

  function test(kind: ConnectionKind) {
    if (!config) {
      throw new Error("Settings have not loaded yet.");
    }

    return testBfdConnection(kind, {
      config,
      secrets: {
        githubToken: githubToken.trim() || undefined,
        jiraToken: jiraToken.trim() || undefined,
      },
    });
  }

  return {
    clearSecret,
    config,
    githubToken,
    jiraToken,
    loading,
    saveResult,
    saveSettings,
    saving,
    secrets,
    setGithubToken,
    setJiraToken,
    test,
    updateArgo,
    updateConfig,
    updateGithub,
    updateJira,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
