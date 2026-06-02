# Devcontainer for OneCLI — Design

**Date:** 2026-06-02
**Status:** Approved (pending spec review)

## Goal

Provide a one-click reproducible development environment ("Reopen in Container")
that boots the full OneCLI monorepo stack — Next.js web app, Rust gateway, and a
Postgres database — with no host setup beyond Docker + an editor that supports
devcontainers.

## Constraints & decisions

- **Toolchains from `.mise.toml`** (node 24, rust latest). The devcontainer
  installs `mise` and lets it resolve versions, so containerized and host
  developers share one source of truth and never drift.
- **Postgres only.** Redis is cloud-edition-only — the web app reads `REDIS_HOST`
  (default `""`, i.e. disabled) and the gateway uses an in-memory `DashMap`
  unless built with `#[cfg(feature = "cloud")]`. OSS dev never touches Redis, so
  it is omitted entirely.
- **No host Docker socket.** Backing services are provided by Docker Compose, so
  the dev container does not need the host daemon. Consequence: `pnpm db:up` /
  `pnpm redis:up` (which shell out to `docker`) are unnecessary and won't run
  from inside the container — compose already supplies Postgres.
- **Postgres image `postgres:18-alpine`** to match production (`docker/Dockerfile`)
  and CI (`.github/workflows/ci.yml`).

## Components (all under `.devcontainer/`)

### 1. `devcontainer.json`

- Compose-based: `dockerComposeFile: docker-compose.yml`, `service: app`,
  `workspaceFolder: /workspaces/onecli`.
- `remoteUser: vscode` (non-root, provided by the base image).
- `forwardPorts`: `10254` (web), `10255` (gateway), `5432` (postgres),
  `5555` (Prisma Studio).
- `customizations.vscode.extensions`: rust-analyzer, Prisma, ESLint, Prettier,
  Tailwind CSS IntelliSense.
- `postCreateCommand`: runs `post-create.sh`.

### 2. `docker-compose.yml`

Two services on a private network:

- **`app`** — built from `Dockerfile`. Mounts the repo at
  `/workspaces/onecli`, runs `command: sleep infinity`. Env
  `DATABASE_URL=postgresql://onecli:onecli@postgres:5432/onecli`. Named volumes
  for the pnpm store and the Rust `target/` directory so installs/builds survive
  container rebuilds. `depends_on` postgres (healthy).
- **`postgres`** — `postgres:18-alpine`, user/password/db = `onecli`,
  `pg_isready` healthcheck, named `pgdata` volume.

### 3. `Dockerfile`

- `FROM mcr.microsoft.com/devcontainers/base:bookworm` (git, common CLI tools,
  non-root `vscode` user).
- System libraries the Rust gateway links against: `build-essential`,
  `pkg-config`, `libssl-dev`, `ca-certificates`.
- Install `mise` and activate it for the `vscode` login shell.

### 4. `post-create.sh`

Idempotent setup run once after container creation:

1. `mise install` — resolves node 24 + rust from `.mise.toml`.
2. `corepack enable && corepack prepare pnpm@9.0.0 --activate`.
3. If `.env` is absent, create it from `.env.example`, rewriting the
   `DATABASE_URL` host from `localhost` to `postgres`.
4. `pnpm install` (also runs husky `prepare`).
5. `pnpm db:generate`.
6. `pnpm db:migrate`.

## Outcome

After "Reopen in Container", these work with no host setup:
`pnpm dev`, `pnpm check`, `pnpm test`, gateway `cargo` builds, and Prisma
migrations / Studio — all against the compose Postgres.

## Out of scope

- Redis / cloud-edition services.
- Mounting the host Docker socket or docker-in-docker.
- CI changes (CI already provisions its own toolchains and Postgres).
