export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function jiraErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  const detail = sanitizedJiraMessage(text) || res.statusText;
  return detail
    ? `Jira API error (${res.status}): ${detail}`
    : `Jira API error (${res.status}).`;
}

function sanitizedJiraMessage(text: string): string {
  if (!text) {
    return "";
  }

  try {
    const data = JSON.parse(text) as {
      errorMessages?: unknown;
      errors?: unknown;
      message?: unknown;
    };
    const messages = Array.isArray(data.errorMessages)
      ? data.errorMessages.map(String)
      : [];
    if (data.errors && typeof data.errors === "object") {
      messages.push(...Object.values(data.errors).map(String));
    }
    if (typeof data.message === "string") {
      messages.push(data.message);
    }
    return messages.join("; ").slice(0, 500);
  } catch {
    return text.replace(/\s+/g, " ").slice(0, 300);
  }
}
