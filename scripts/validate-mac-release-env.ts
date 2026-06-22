const requiredVariables = [
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
] as const;

const missing = requiredVariables.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(
    `Missing macOS release environment variables: ${missing.join(", ")}`
  );
  console.error("Copy .env.example to .env and fill in the real values.");
  process.exit(1);
}
