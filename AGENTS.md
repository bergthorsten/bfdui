# AGENTS.md — BFD Desktop App Agent Guide

Long-lived guidance for agents working on this app. For the current implementation status and open tasks, read [`TODO.md`](./TODO.md).

## Vision

BFD is an internal Electron desktop app that turns common `bfd` deployment workflows into a calm, fast dashboard:

- Show Jira sprint tickets with related PRs/branches.
- Show which dev system each ticket/branch is deployed to.
- Make free dev systems obvious.
- deploy/redeploy branches, reset systems back to `master`, track GitHub Actions, detect outdated deployments, and notify on failures/success.

The MVP foundation is a trustworthy read-only dashboard. Add deployment mutations only after the data model and read-only views are correct.

We want to build something relay good and stable! So dont just copy past, When you see opertunities to do better, do it!

## Important
!! Never run any deployment yourself, or test a deployment !! 
!! Deployments should never been tested e2e !! Ony me (the human) does this at the end!
!! Never run any harmfull argo, gh commands yourself !!
!! Deployment blocker has been removed for final human-run deployment validation. Agents still must not run or test deployments automatically. !!

## Ground truth learned so far

- Real BFD CLI source: `~/devenv/src/tools/bf-deploy`.
- The CLI is useful behavioral truth, but it is interactive and not machine-friendly for the desktop UX:
  - `bfd c` / `bfd check` has no `--json` today.
  - `bfd d` / `bfd deploy` can prompt and has no stable `--json`/`--no-interactive` contract today.
  - `bfd d ... -d` means `--use-defaults`, not “deploy”.
- Jira is **Jira Cloud**:
  - Site URL is configurable; current default is `https://jirabergfreunde.atlassian.net`.
  - Old incorrect default `https://bergfreunde.atlassian.net` is migrated automatically by config loading/saving.
  - REST API: `/rest/api/3`.
  - Auth: Atlassian account email + API token via Basic auth.
  - JQL search should use Jira Cloud search pagination (`/rest/api/3/search/jql` with `nextPageToken`).
  - Jira dev panel/GitHub integration data is read through Jira's internal dev-status endpoints:
    - Summary: `/rest/dev-status/latest/issue/summary?issueId=<id>`.
    - Detail: `/rest/dev-status/latest/issue/detail?issueId=<id>&applicationType=<summary key>&dataType=branch|pullrequest|build`.
    - Do not hardcode `applicationType=GitHub`; this tenant reports keys like `oAuth-com.github.integration.production` and `cloud-providers`.
    - These endpoints are internal/unsupported. Keep parsing tolerant, fail soft, and consider GitHub API as fallback/enrichment if needed.
    - Dev-status data is intentionally cached for 10 minutes and should refresh mainly from explicit `Refresh Jira`.
    - Debug logging is off by default; use `BFD_JIRA_DEV_DEBUG=1` for `[jira-dev]` diagnostics.
- Argo/dev-system model:
  - BFD reads ArgoCD `Application` CRDs directly with `kubectl`; do not reintroduce `argocd --core` because it can require broad Kubernetes secret permissions.
  - Expected command shape: `kubectl --context <context> -n <argocdNamespace> get applications.argoproj.io -l app=<app> -o json`.
  - Useful RBAC check: `kubectl --context <context> auth can-i list applications.argoproj.io -n <argocdNamespace>`.
  - Real namespaces: `01`–`16`, `20`, `epm`, `oms`, `sap`.
  - Reserved systems: `20`, `epm`, `oms`, `sap`.
  - Branch-to-ticket regex: `^([A-Z]+-[0-9]+)-`.
  - A non-reserved system on `master` is treated as free.
- GitHub defaults: owner `bergfreunde`, repo `shop`. Prefer GitHub API; local `gh` CLI token reuse can be an option/fallback.
- Keep config self-contained for this app. Do not import, log, or render credential-bearing old BFD config values.

## Engineering guidelines

- Build modern, maintainable TypeScript/React/Electron code. Prefer small focused components, explicit domain types, and accessible UI states.
- Write good tests! 
- Make it useable via the Keyboard! Use good defaults for thinks like (strg + f) to focus the search! 
- Prefer native integrations in Electron main-process services plus IPC/TanStack Query over shelling out to interactive commands.
- Keep secrets in the main process. Renderer code may receive only non-secret config and secret-presence booleans.
- Keep mock data out of live rows. Dashboard live Jira rows should not inherit `src/data/mock.ts` PRs/deployments; mock data is preview-only until corresponding live integrations exist.
- Keep changes targeted and surgical, but prefactor when it clearly makes the change simpler and safer.
- Maintain good verification habits:
  - Static: `npm run check`, `npx tsc --noEmit`.
  - Auto-format/fix: `npm run fix`.
  - Unit tests: `npm test`.
  - Browser/UI: use the `bergflow-tester` agent for visible frontend changes when needed, and report concrete evidence.
- Do not run destructive/lifecycle commands without explicit approval.
- Do not edit generated `src/routeTree.gen.ts` manually; TanStack Router regenerates it.
- Treat `BFD_DESKTOP_APP_PLAN.md` as useful product/research context. Its Jira Cloud direction is now the active direction.

## Auto-Updates and Releases

- BFD uses `update-electron-app` with `update.electronjs.org` and GitHub Releases for packaged macOS updates.
- Supported release artifacts are macOS and Linux only. There is no Windows version; do not trigger Windows publishing workflows or create Windows release assets.
- In production, the app checks on startup and hourly. Settings also exposes a manual `Check for updates` button.
- When an update is downloaded, Electron shows a native `Restart` / `Later` dialog; choosing `Restart` installs the update.
- `npm start` is development mode, so update checks intentionally log that they are disabled.
- macOS auto-update requires a signed ZIP asset attached to the GitHub Release. The DMG is for first-time/manual installs.
- Use `npm run release:mac` from the trusted signing Mac for real releases. It expects a clean tree, builds signed macOS artifacts, creates/pushes `v<package.json version>`, creates the GitHub Release, and uploads DMG + ZIP assets. The pushed tag triggers the Desktop Builds workflow to upload Linux DEB/RPM/ZIP artifacts to the same release.
- Before `npm run release:mac`, commit the version bump and app changes. `.env` must contain Apple signing/notarization values, and `gh` must be authenticated or `GITHUB_TOKEN` must be set.
- Use `npm run make:mac` only for local artifact testing; it does not create a GitHub Release and does not make assets downloadable.
- Never commit Apple credentials, app-specific passwords, GitHub tokens, `.p12` certificates, or generated `out/` artifacts.

## Important files

- [`TODO.md`](./TODO.md): current status, next tasks, verification notes.
- [`BFD_DESKTOP_APP_PLAN.md`](./BFD_DESKTOP_APP_PLAN.md): broader product/research plan.
- `src/types/bfd.ts`: shared domain model.
- `src/services/config.ts`: local config and encrypted secret storage.
- `src/services/jira.ts`: Jira Cloud REST v3, global ticket search, and dev-status PR/branch/build integration.
- `src/data/mock.ts`: preview-only mock tickets/deployments; do not merge into live dashboard rows.
- `src/routes/index.tsx`: Dashboard.
- `src/routes/systems.tsx`: Dev Systems view.
- `src/routes/settings.tsx`: Settings and integration test controls.
- `src/components/*`: app shell, tables, badges, stat cards, UI composition.

## Running locally

From `/Users/thors876/Code/bfdui`:

```sh
npm start
```

This starts Electron via `electron-forge start`. Use this for the real app because some behavior depends on Electron IPC.
