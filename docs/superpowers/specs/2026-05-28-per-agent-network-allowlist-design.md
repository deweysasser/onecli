# Per-Agent Network Allow Lists

**Date:** 2026-05-28
**Status:** Approved design — ready for implementation planning

## Problem

The OneCLI gateway behaves as an effectively open HTTP proxy. Although a
policy engine exists (`apps/gateway/src/policy.rs`) with a deny-by-default
mode, two things prevent it from acting as a real network allow list:

1. **Enforcement is coupled to credentials.** In `forward.rs:153` and
   `websocket.rs:104`, `enforce_deny = has_injections && !is_llm_host(host)`.
   Deny mode therefore only blocks hosts the gateway already holds credentials
   for. A host with no injections (e.g. `evil.com`) is allowed straight
   through.
2. **No per-agent control.** `policyMode` lives only on `Organization`
   (`schema.prisma:23`, joined into the agent at `db.rs:141`). There is no way
   to lock down one agent while leaving another open, and no UI for an
   allow list.

We want: **every agent talks to Anthropic (for AI) and nothing else by
default; an operator can allow additional domains by name, or allow unlimited
communication — configured per agent, with a global list as well.**

## Goals

- Per-agent network policy: locked-down (default), allow-listed, or open.
- A global allow list applying to all agents, plus per-agent additions.
- Reuse the existing policy engine and `PolicyRule` storage — one enforcement
  path, no second system.
- Configurable via the management REST API so orchestrators (nanoclaw) can set
  an agent's mode and allow list at provisioning time.
- A web UI for managing per-agent and global lists.

## Non-Goals

- A separate allow-list data model or enforcement engine (explicitly rejected
  in favor of reuse).
- SDK wrapper methods themselves — `@onecli-sh/sdk` lives outside this repo.
  This spec defines the REST contract the SDK will wrap.
- CLI-side local enforcement / defense-in-depth (the gateway is the single
  enforcement point).

## Mental Model

Three user-facing states per agent, all expressed through existing machinery:

| State                | Stored as                                        | Behavior                                                                |
| -------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| **Locked (default)** | `policyMode = deny`, no extra allow rules        | Only domains with a global Allow rule (seeded: Anthropic) are reachable |
| **Allow-listed**     | `policyMode = deny` + agent-scoped `Allow` rules | Anthropic + named domains                                               |
| **Open**             | `policyMode = allow`                             | Unlimited                                                               |

The "allow list" is just `Allow` `PolicyRule` rows:

- **Global** = `agentId = null` (org/project scope) — already supported.
- **Per-agent** = `agentId = <id>` — already supported by the resolver filter
  at `connect.rs:715`.

## Design

### 1. Data model

- Add **`Agent.policyMode String?`** — nullable; `null` = inherit the org
  default. Mirrors `Organization.policyMode` semantics.
- `db.rs` agent query (`db.rs:141`): change `o.policy_mode` to
  `COALESCE(a.policy_mode, o.policy_mode)` so the gateway resolves the
  _effective_ mode with no extra query. The resolved value continues to flow
  through `ConnectResponse.policy_mode`.
- **Migration:**
  - Pin all existing organizations to `policyMode = "allow"` (preserve current
    behavior — nothing breaks on upgrade).
  - Change the `Organization.policyMode` column default to `"deny"` for new
    orgs (new-default-deny rollout).
  - Seed each organization a **global Allow rule** for Anthropic
    (`api.anthropic.com` plus the console/OAuth hosts required by the
    token-exchange flow — to be confirmed against the Anthropic injection
    logic in `connect.rs` `build_injections`). Tag it with
    `metadata = { source: "ai_baseline" }` so the UI can recognize it.

### 2. Enforcement (core fix)

- Drop the `has_injections` coupling and the `is_llm_host` bypass. `enforce_deny`
  becomes simply _"is the effective mode `deny`?"_. Anthropic is then reachable
  only because of its seeded Allow rule — a single path, nothing magic.
- Delete `is_llm_host` and its usages in `forward.rs` / `websocket.rs`.
  (Keep any always-log behavior for LLM traffic if it is independently
  required — verify during implementation; it must not re-introduce an
  enforcement bypass.)
- **CONNECT-time gate** in `handle_connect` (`gateway.rs:506`):
  `ConnectResponse` already carries `policy_rules` and `policy_mode`. Add a
  host-level allow check — if effective mode is `deny` and no rule's
  `hostPattern` matches the host, return **403 on the CONNECT** (no tunnel is
  opened). If the host matches an allow rule, proceed to MITM as today, where
  the existing per-request rules (block / manual_approval / rate_limit on
  specific paths) still apply.
  - Host match reuses `host_matches` (`connect.rs:997`), which already supports
    exact and `*.example.com` wildcard patterns.
  - "Matches an allow rule" at the host level means any rule whose host pattern
    matches and whose action is `Allow`/`RateLimit`/`ManualApproval` (the same
    set treated as an implicit allow in `policy::evaluate` pass 4).

### 3. Management API (nanoclaw's configuration path)

- **Per-agent mode:** extend `PATCH /agents/:id` (`packages/api/src/routes/agents.ts`,
  `agent-service.ts`, `validations/agent.ts`) to accept
  `policyMode: "allow" | "deny" | null`. Validation uses the existing
  `policyModeSchema`, extended to allow `null` for inherit.
- **Allow entries:** `POST` / `PATCH` / `DELETE /rules` already accept
  `action: "allow"`, optional `agentId`, and `hostPattern`
  (`validations/policy-rule.ts`). No new endpoint required.
- Both paths already invalidate the gateway cache
  (`invalidateGatewayCache`); the new agent-mode update must do the same
  (invalidate for the agent's org, as `policy-mode.ts` does today).
- All mutations remain audited via `withAudit` per the project convention.

### 4. Web UI

- **Agent detail page:** a network-mode control — Inherit / Locked (deny) /
  Open (allow) — plus an "Allowed domains" editor (add/remove host patterns,
  each persisted as an agent-scoped `Allow` rule).
- **Rules page / org settings:** a **global allow list** section
  (`agentId = null` Allow rules), and surface `Allow` as a first-class rule
  action (the UI currently shows block / rate_limit / manual_approval; the
  backend and validation already understand `allow`). The existing
  `RulesContent` already takes `policyMode` and an agent field, so this is
  incremental.
- The seeded Anthropic baseline rule renders with a warning: _"This is the AI
  baseline — removing it cuts off AI access for locked-down agents."_

### 5. Blocked-request contract (for the CLI / agent)

A blocked CONNECT returns a structured 403 the CLI/agent can recognize and
surface clearly instead of an opaque proxy failure:

- A distinguishing header (e.g. `x-onecli-policy: blocked`) and a JSON body
  naming the blocked host, the agent, and a remediation hint ("add this domain
  to the agent's allow list"). Exact shape to align with existing gateway
  error responses in `gateway/response.rs`.

## Affected Components

- `apps/gateway/src/` — `policy.rs` (drop `is_llm_host`/`has_injections`
  coupling), `gateway.rs` (`handle_connect` allow gate), `gateway/forward.rs`,
  `gateway/websocket.rs`, `connect.rs` (effective mode), `db.rs`
  (`COALESCE` query), `gateway/response.rs` (blocked-CONNECT contract).
- `packages/db/prisma/schema.prisma` + migration (`Agent.policyMode`, default
  flip, existing-org pin, Anthropic baseline seed).
- `packages/api/src/` — `routes/agents.ts`, `services/agent-service.ts`,
  `validations/agent.ts`, `validations/policy-rule.ts` (allow `null` mode).
- `apps/web/src/` — agent detail UI, rules page (global list + `allow` action),
  related actions/hooks (`lib/actions/rules.ts`, a per-agent mode action),
  baseline-rule warning.

## Rollout / Compatibility

- Existing orgs pinned to `allow` → zero behavior change on upgrade.
- New orgs default to `deny` (locked-down, Anthropic-only).
- Release notes must document the new default and how to add allow rules.

## Open Items to Confirm During Implementation

- Exact set of Anthropic hosts required for the OAuth/token-exchange flow
  (verify against `build_injections` and the Anthropic OAuth path).
- Whether any "always log LLM traffic" behavior must be preserved independently
  of the deleted `is_llm_host` bypass.
- Whether the global allow list is scoped at org level (assumed) vs. project
  level for the UI surface.
