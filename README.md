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

## Notes

- Secrets are stored through Electron `safeStorage` and are not returned to the renderer.
- Deployment/reset controls are intentionally blocked until the production workflow is wired and validated.
- Publishing is not configured yet for this internal app.
