# BFD Desktop

BFD is an internal Electron desktop dashboard for Bergfreunde dev deployments.

It combines Jira sprint tickets, GitHub development metadata, and ArgoCD dev-system state so engineers can see what is deployed where and which systems are available.

## Development

```bash
npm install
npm run start
```

## Checks

```bash
npm run check
npm test
npm run test:coverage
```

## Updates and Releases

BFD uses `update-electron-app` with GitHub Releases through the public Electron update service. Packaged macOS builds check for updates on startup and then every hour. Users can also open Settings and click `Check for updates`.

When an update has downloaded, Electron shows a native dialog with `Restart` and `Later`. Choosing `Restart` quits and installs the update. During `npm start`, update checks are disabled because the app is running in development mode.

Supported release artifacts are macOS and Linux only. There is no Windows version of BFD Desktop; do not publish or announce Windows builds.

macOS auto-update requires the signed ZIP artifact on the GitHub release. The DMG is for first-time/manual installs.

Release a new macOS version from the trusted signing Mac:

1. Bump `version` in `package.json` and `package-lock.json`.
2. Commit the version bump and intended app changes.
3. Ensure `.env` contains Apple signing/notarization values.
4. Ensure `gh` is authenticated with release write access, or set `GITHUB_TOKEN`.
5. Run:

```bash
npm run release:mac
```

The release command requires a clean working tree. It builds signed macOS artifacts, creates and pushes tag `v<version>`, creates the GitHub Release, and uploads both the DMG and ZIP. The pushed tag also triggers the Desktop Builds workflow, which attaches Linux DEB/RPM/ZIP artifacts to the same release.

For a local build without publishing:

```bash
npm run make:mac
```

## MCP Server

BFD starts a local MCP Streamable HTTP server automatically while the desktop app is open. It uses the same app configuration, ArgoCD access, and GitHub authentication as the dashboard.

- Endpoint: `http://127.0.0.1:3827/mcp`
- Bind address: localhost only (`127.0.0.1`)

Available tools:

- `ticket_deployment_status`: checks whether a Jira ticket is currently deployed, where it is deployed, deployment date/status, and whether the deployed branch has newer commits.
- `list_deployments`: lists current deployments with environment/server, branch, deployment date, Argo sync/health status, and freshness information.

## Notes

- Secrets are stored through Electron `safeStorage` when available and are not returned to the renderer. If OS encryption is unavailable, BFD falls back to local plaintext token files.
- Deployment controls are enabled for final human-run validation; automated agents must not run deployments.
- Keep the signed macOS ZIP attached to each GitHub Release; the updater depends on it.
