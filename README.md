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
- Publishing is not configured yet for this internal app.
