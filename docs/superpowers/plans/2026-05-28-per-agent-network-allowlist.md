# Per-Agent Network Allow Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the OneCLI gateway from an effectively-open proxy into a per-agent network allow list — every agent reaches Anthropic by default and nothing else, operators allow extra domains by name (per-agent or globally), or set an agent fully open.

**Architecture:** Reuse the existing policy engine and `PolicyRule` storage — one enforcement path. Add a nullable per-agent `policyMode` that overrides the org default; express allow lists as `Allow` policy rules (`agentId = null` = global, `agentId = set` = per-agent). In deny mode a host is allowed if it has an allow-family rule **or** OneCLI-managed credentials for it (a secret/app-connection injection) — so AI backends are reachable purely by having a credential, with no seeded baseline rule needed. Fix deny enforcement so it blocks unknown domains; gate blocked domains at CONNECT so no tunnel opens.

**Tech Stack:** Rust (hyper/axum gateway, `cargo test`), Prisma + PostgreSQL, Hono REST API (TypeScript), Next.js 16 App Router + React + shadcn/ui.

**Reference spec:** `docs/superpowers/specs/2026-05-28-per-agent-network-allowlist-design.md`

---

## File Structure

**Phase 1 — Data model**
- Modify: `packages/db/prisma/schema.prisma` (`Agent.policyMode`, org default flip)
- Create: `packages/db/prisma/migrations/<ts>_per_agent_policy_mode/migration.sql`

**Phase 2 — Gateway enforcement (Rust)**
- Modify: `apps/gateway/src/db.rs` (effective mode via `COALESCE`)
- Modify: `apps/gateway/src/policy.rs` (`evaluate` gains `host_has_credentials`; delete `is_llm_host`)
- Modify: `apps/gateway/src/gateway/forward.rs` + `apps/gateway/src/gateway/websocket.rs` (enforce on mode, not injections)
- Modify: `apps/gateway/src/connect.rs` (host-allow helper on `ConnectResponse`)
- Modify: `apps/gateway/src/gateway.rs` (CONNECT-time gate in `handle_connect`)
- Modify: `apps/gateway/src/gateway/response.rs` (`connect_blocked` builder)

**Phase 3 — Management API (TypeScript)**
- Modify: `packages/api/src/validations/agent.ts` (`agentPolicyModeSchema`)
- Modify: `packages/api/src/services/agent-service.ts` (`updateAgentPolicyMode`)
- Modify: `packages/api/src/routes/agents.ts` (`PATCH /agents/:agentId/policy-mode`)

**Phase 4 — Web UI**
- Modify: `apps/web/src/app/(dashboard)/rules/_components/custom-endpoint-form.tsx` (`allow` action option)
- Modify: `apps/web/src/app/(dashboard)/rules/_components/rule-card.tsx` (render allow action)
- Create: `apps/web/src/app/(dashboard)/agents/_components/network-access-dialog.tsx`
- Modify: `apps/web/src/app/(dashboard)/agents/_components/agent-card.tsx` (open the dialog)
- Modify: `apps/web/src/lib/actions/agents.ts` (per-agent policy-mode action) and `apps/web/src/lib/api/agents.ts` (client method)

---

## Phase 1 — Data model & migration

### Task 1: Add per-agent `policyMode` and flip the org default

**Files:**
- Modify: `packages/db/prisma/schema.prisma:156-175` (Agent), `:23` (Organization default)
- Create: `packages/db/prisma/migrations/<timestamp>_per_agent_policy_mode/migration.sql`

- [ ] **Step 1: Add the field to the Agent model**

In `schema.prisma`, inside `model Agent`, add after `secretMode` (`:163`):

```prisma
  policyMode  String?  @map("policy_mode") // null = inherit org default; "allow" | "deny"
```

- [ ] **Step 2: Flip the Organization default to deny**

Change `schema.prisma:23` from:

```prisma
  policyMode         String   @default("allow") @map("policy_mode") // "allow" | "deny"
```

to:

```prisma
  policyMode         String   @default("deny") @map("policy_mode") // "allow" | "deny"
```

- [ ] **Step 3: Create the migration SQL**

Create `packages/db/prisma/migrations/<timestamp>_per_agent_policy_mode/migration.sql` (use a timestamp later than `20260525165914`, e.g. `20260528120000_per_agent_policy_mode`):

```sql
-- Per-agent override (null = inherit org default)
ALTER TABLE "agents" ADD COLUMN "policy_mode" TEXT;

-- New orgs default to locked-down; existing orgs already hold 'allow' from the
-- prior migration's default, so flipping the default does NOT change them.
ALTER TABLE "organizations" ALTER COLUMN "policy_mode" SET DEFAULT 'deny';
```

No seeded allow rule: in deny mode a host with OneCLI-managed credentials is
implicitly allowed (Tasks 3 & 5), so AI backends are reachable as soon as a
credential exists. An agent with no managed credential for a host is blocked
until an explicit allow rule is added — this is the intended behavior.

- [ ] **Step 4: Apply the migration and regenerate the client**

Run: `pnpm db:migrate` (dev) then `pnpm db:generate`
Expected: migration applies cleanly; `prisma generate` reports success.

- [ ] **Step 5: Verify the column and defaults**

Run: `pnpm db:studio` (or `psql`) and confirm: `agents.policy_mode` is nullable; existing org rows still read `policy_mode='allow'`; a freshly inserted org row gets `policy_mode='deny'`.

- [ ] **Step 6: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "feat(db): per-agent policyMode, deny default, seed Anthropic baseline"
```

---

## Phase 2 — Gateway enforcement (Rust, TDD)

### Task 2: Resolve the effective policy mode (agent overrides org)

**Files:**
- Modify: `apps/gateway/src/db.rs:141` (agent query)

- [ ] **Step 1: Update the agent SQL to coalesce agent over org**

In `db.rs`, the query at `:141` currently selects `o.policy_mode`. Change that projection to:

```sql
COALESCE(a.policy_mode, o.policy_mode) AS policy_mode
```

Keep the surrounding `SELECT a.id, a.name, a.identifier, a.project_id, p.organization_id, a.secret_mode, o.subscription_status, ...` intact; only the `policy_mode` column changes. The `AgentRow.policy_mode: String` field (`db.rs:32`) already holds the result — no struct change needed.

- [ ] **Step 2: Build to confirm the query still maps**

Run (cwd `apps/gateway`): `cargo build`
Expected: compiles. (SQLx maps `COALESCE(...)::text` to `String`; if SQLx complains about nullability, wrap as `COALESCE(a.policy_mode, o.policy_mode) AS "policy_mode!"`.)

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/db.rs
git commit -m "feat(gateway): resolve effective policy mode (agent overrides org)"
```

### Task 3: `evaluate` honors credentials as an implicit allow

Rationale: in deny mode a domain is allowed if it has an allow-family rule **or** the operator configured credentials for it (a secret or app connection) — so connecting an app doesn't dead-end. Anthropic works via its seeded rule regardless.

**Files:**
- Modify: `apps/gateway/src/policy.rs:66-155` (`evaluate`), tests in same file

- [ ] **Step 1: Write failing tests for credential-implies-allow**

Add to `policy.rs` `mod tests` (these call `evaluate` with a new trailing `host_has_credentials` argument that does not exist yet):

```rust
#[tokio::test]
async fn deny_mode_allows_when_host_has_credentials() {
    let store = crate::cache::create_store().await.unwrap();
    let rules: Vec<PolicyRule> = vec![];
    let d = evaluate(
        "POST", "/v1/messages", None, &rules, "agent1", &*store, "deny", true, true,
    )
    .await;
    assert!(matches!(d, PolicyDecision::Allow));
}

#[tokio::test]
async fn deny_mode_blocks_when_no_rule_and_no_credentials() {
    let store = crate::cache::create_store().await.unwrap();
    let rules: Vec<PolicyRule> = vec![];
    let d = evaluate(
        "GET", "/", None, &rules, "agent1", &*store, "deny", true, false,
    )
    .await;
    assert!(matches!(d, PolicyDecision::BlockedByDefaultPolicy));
}
```

- [ ] **Step 2: Run to confirm failure**

Run (cwd `apps/gateway`): `cargo test deny_mode_allows_when_host_has_credentials deny_mode_blocks_when_no_rule_and_no_credentials`
Expected: FAIL to compile — `evaluate` takes 8 args, not 9.

- [ ] **Step 3: Add the parameter and use it in pass 4**

Change the `evaluate` signature (`policy.rs:66`) to add a trailing param:

```rust
pub(crate) async fn evaluate(
    request_method: &str,
    request_path: &str,
    request_body: Option<&[u8]>,
    rules: &[PolicyRule],
    agent_token: &str,
    cache: &dyn CacheStore,
    policy_mode: &str,
    enforce_deny: bool,
    host_has_credentials: bool,
) -> PolicyDecision {
```

In pass 4 (`policy.rs:141-152`), change the block to:

```rust
    // Pass 4: in deny mode, require an explicit allow rule (or configured
    // credentials for the host) when enforced.
    if policy_mode == "deny" && enforce_deny {
        let has_allow = rules.iter().any(|rule| {
            matches_request(rule, request_method, request_path, request_body)
                && matches!(
                    rule.action,
                    PolicyAction::Allow | PolicyAction::RateLimit { .. }
                )
        });
        if !has_allow && !host_has_credentials {
            return PolicyDecision::BlockedByDefaultPolicy;
        }
    }
```

- [ ] **Step 4: Update every existing `evaluate` call site in tests**

In `policy.rs` tests, every existing `evaluate(...)` call passes 8 args. Add a trailing `false` to each (no credentials, preserving prior behavior). There are calls in: `rate_limit_allows_under_limit`, `rate_limit_blocks_over_limit`, `rate_limit_per_agent_isolation`, `block_takes_precedence_over_rate_limit`, `evaluate_allows_non_matching_rules`, `manual_approval_matches_path_and_method`, `manual_approval_no_match_different_method`, `block_takes_precedence_over_manual_approval`, `manual_approval_takes_precedence_over_rate_limit`, `deny_mode_blocks_when_no_allow_rule`, `deny_mode_allows_with_explicit_allow_rule`, `deny_mode_block_overrides_allow`, `deny_mode_rate_limit_implicit_allow`, `deny_mode_manual_approval_implicit_allow`, `deny_mode_non_matching_allow_still_blocks`, `allow_mode_ignores_allow_rules`, `deny_mode_allows_without_injections`, `allow_mode_empty_string_same_as_allow`.

Example — `deny_mode_blocks_when_no_allow_rule` becomes:

```rust
    let d = evaluate(
        "POST", "/api/v1/messages", None, &rules, "agent1", &*store, "deny", true, false,
    )
    .await;
    assert!(matches!(d, PolicyDecision::BlockedByDefaultPolicy));
```

- [ ] **Step 5: Run the full policy test module**

Run (cwd `apps/gateway`): `cargo test --lib policy::`
Expected: PASS (including the two new tests).

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/policy.rs
git commit -m "feat(gateway): treat configured credentials as implicit allow in deny mode"
```

### Task 4: Enforce deny on mode (drop `is_llm_host` / `has_injections` coupling)

**Files:**
- Modify: `apps/gateway/src/policy.rs` (delete `is_llm_host` + its tests)
- Modify: `apps/gateway/src/gateway/forward.rs:152-164`
- Modify: `apps/gateway/src/gateway/websocket.rs:103-116`

- [ ] **Step 1: Delete `is_llm_host` and its tests**

Remove the `is_llm_host` function (`policy.rs:187-198`) and the three tests `is_llm_host_matches_known_providers`, `is_llm_host_strips_port`, `is_llm_host_rejects_non_llm` (`policy.rs:726-747`).

- [ ] **Step 2: Fix `forward.rs` to enforce on mode and pass credentials**

In `forward.rs`, replace the `has_injections` / `enforce_deny` lines (`:152-153`) and the `evaluate` call (`:155-164`) with:

```rust
    let host_has_credentials =
        !rules.injection_rules.is_empty() || !rules.app_connections.is_empty();
    let enforce_deny = rules.policy_mode == "deny";

    let decision = policy::evaluate(
        method.as_str(),
        &path,
        condition_buffer.as_deref(),
        &rules.policy_rules,
        agent_token,
        cache,
        &rules.policy_mode,
        enforce_deny,
        host_has_credentials,
    )
    .await;
```

(If `ResolvedRules` has no `app_connections` field on the per-request struct, use `!rules.injection_rules.is_empty()` alone — verify the field on `ResolvedRules` in `mitm.rs` and adjust.)

- [ ] **Step 3: Fix `websocket.rs` the same way**

In `websocket.rs`, replace `:103-116`:

```rust
    let host_has_credentials =
        !rules.injection_rules.is_empty() || !rules.app_connections.is_empty();
    let enforce_deny = rules.policy_mode == "deny";

    let decision = policy::evaluate(
        "GET",
        &path,
        None,
        &rules.policy_rules,
        agent_token,
        cache,
        &rules.policy_mode,
        enforce_deny,
        host_has_credentials,
    )
    .await;
```

Remove the now-unused `has_injections` binding and the `host` argument if it becomes unused (the compiler will flag it).

- [ ] **Step 4: Build and run gateway tests**

Run (cwd `apps/gateway`): `cargo build && cargo test --lib`
Expected: compiles with no reference to `is_llm_host`; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/policy.rs apps/gateway/src/gateway/forward.rs apps/gateway/src/gateway/websocket.rs
git commit -m "feat(gateway): enforce deny by mode, not by credential presence; drop is_llm_host"
```

### Task 5: Block unknown domains at CONNECT (no tunnel)

**Files:**
- Modify: `apps/gateway/src/connect.rs` (add `host_allowed_at_connect` + tests)
- Modify: `apps/gateway/src/gateway/response.rs` (add `connect_blocked`)
- Modify: `apps/gateway/src/gateway.rs:525-547` (use full response + gate)

- [ ] **Step 1: Write a failing test for the host-allow helper**

Add to `connect.rs` `mod tests`:

```rust
#[test]
fn connect_gate_allows_in_allow_mode() {
    let mut r = ConnectResponse::default();
    r.policy_mode = "allow".to_string();
    assert!(r.host_allowed_at_connect("evil.com"));
}

#[test]
fn connect_gate_blocks_unknown_host_in_deny_mode() {
    let mut r = ConnectResponse::default();
    r.policy_mode = "deny".to_string();
    assert!(!r.host_allowed_at_connect("evil.com"));
}

#[test]
fn connect_gate_allows_matching_allow_rule_in_deny_mode() {
    let mut r = ConnectResponse::default();
    r.policy_mode = "deny".to_string();
    r.policy_rules = vec![PolicyRule {
        name: "anthropic".to_string(),
        path_pattern: "*".to_string(),
        method: None,
        action: PolicyAction::Allow,
        conditions_raw: None,
    }];
    // host_pattern lives on the DB row, not PolicyRule; see Step 3 note.
    assert!(r.host_allowed_at_connect("api.anthropic.com"));
}

#[test]
fn connect_gate_allows_when_credentials_present_in_deny_mode() {
    let mut r = ConnectResponse::default();
    r.policy_mode = "deny".to_string();
    r.injection_rules = vec![InjectionRule { path_pattern: "*".to_string(), injections: vec![] }];
    assert!(r.host_allowed_at_connect("api.example.com"));
}
```

- [ ] **Step 2: Run to confirm failure**

Run (cwd `apps/gateway`): `cargo test --lib connect::tests::connect_gate`
Expected: FAIL to compile — `host_allowed_at_connect` does not exist.

- [ ] **Step 3: Implement the helper**

Note: `PolicyRule` (in `policy.rs`) does **not** carry `host_pattern` — host filtering happens in `resolve_policy_rules` (`connect.rs:713`), so `ConnectResponse.policy_rules` are already filtered to the connecting host. Therefore the gate does not re-match host patterns on `policy_rules`; presence of an allow-family rule means it already matched this host. Add this method on `ConnectResponse` in `connect.rs`:

```rust
impl ConnectResponse {
    /// Whether the agent may open a tunnel to `hostname` at CONNECT time.
    /// In allow mode, everything is permitted. In deny mode, the host must
    /// have an allow-family policy rule (already host-filtered at resolve
    /// time) or configured credentials (secret / app connection).
    pub(crate) fn host_allowed_at_connect(&self, _hostname: &str) -> bool {
        if self.policy_mode != "deny" {
            return true;
        }
        let has_allow_rule = self.policy_rules.iter().any(|r| {
            matches!(
                r.action,
                PolicyAction::Allow | PolicyAction::RateLimit { .. } | PolicyAction::ManualApproval { .. }
            )
        });
        has_allow_rule
            || !self.injection_rules.is_empty()
            || !self.app_connections.is_empty()
    }
}
```

(`_hostname` is kept in the signature for symmetry and future per-host logic; rules are pre-filtered so it is unused today.)

- [ ] **Step 4: Run the helper tests**

Run (cwd `apps/gateway`): `cargo test --lib connect::tests::connect_gate`
Expected: PASS. (Remove the misleading `host_pattern` comment line added in Step 1's third test.)

- [ ] **Step 5: Add the `connect_blocked` response builder**

In `response.rs`, mirror `blocked_by_default_policy` (`:369`) but return the CONNECT body type used by `handle_connect` (`Response<axum::body::Body>`). Add:

```rust
/// 403 for a CONNECT to a host with no allow rule in deny mode (no tunnel).
pub(crate) fn connect_blocked(host: &str, project_id: Option<&str>) -> Response<axum::body::Body> {
    let base = scoped_url(dashboard_url(), "", project_id);
    let hostname = host.split(':').next().unwrap_or(host);
    let encoded_host = utf8_percent_encode(hostname, NON_ALPHANUMERIC);
    let body = serde_json::json!({
        "error": "blocked_by_default_policy",
        "message": format!(
            "{hostname} is not on this agent's network allow list. \
             Add it in your OneCLI dashboard or set the agent to open."
        ),
        "host": hostname,
        "dashboard_url": format!("{base}/rules?create=allow&host={encoded_host}"),
    })
    .to_string();
    let mut resp = Response::new(axum::body::Body::from(body));
    *resp.status_mut() = StatusCode::FORBIDDEN;
    resp.headers_mut().insert(
        "content-type",
        hyper::header::HeaderValue::from_static("application/json"),
    );
    resp.headers_mut().insert(
        "x-onecli-policy",
        hyper::header::HeaderValue::from_static("blocked"),
    );
    resp
}
```

Confirm `axum`, `StatusCode`, `scoped_url`, `dashboard_url`, `utf8_percent_encode`, `NON_ALPHANUMERIC` are already imported in `response.rs` (they are used by the existing builders); add imports only if the compiler flags them.

- [ ] **Step 6: Wire the gate into `handle_connect`**

In `gateway.rs:525-547`, capture the full resolve response instead of destructuring only some fields, then gate before spawning the tunnel. Replace the `let (mut intercept, project_id, ...) = if let Some(ref token) ...` block so that on the `Ok(resp)` arm you keep `resp`, and immediately after resolving (still inside `handle_connect`, before the `tokio::spawn`) add:

```rust
    // Deny-mode allow-list gate: refuse the CONNECT (no tunnel) when the host
    // is not permitted for this agent.
    if let Some(ref resp) = connect_response {
        if !resp.host_allowed_at_connect(&hostname) {
            warn!(peer = %peer_addr, host = %host, "CONNECT blocked by network allow list");
            return Ok(response::connect_blocked(&host, resp.project_id.as_deref()));
        }
    }
```

Concretely: introduce `let connect_response: Option<connect::ConnectResponse>` from the `resolve` call, derive `intercept`, `project_id`, `organization_id`, `agent_id`, `agent_name`, `agent_identifier` from it (clone the fields you already destructured), and run the gate above before the existing vault-fallback / force-MITM logic. Unauthenticated requests (`connect_response = None`) keep current behavior.

- [ ] **Step 7: Build and run all gateway tests**

Run (cwd `apps/gateway`): `cargo build && cargo test`
Expected: compiles; all unit + integration tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/connect.rs apps/gateway/src/gateway/response.rs apps/gateway/src/gateway.rs
git commit -m "feat(gateway): block disallowed domains at CONNECT with structured 403"
```

### Task 6: Manual end-to-end gateway check

- [ ] **Step 1: Verify deny + allow behavior locally**

With a local stack and an agent whose effective mode is `deny`:
- `curl -x http://localhost:<gw> -H "Proxy-Authorization: Bearer <aoc_token>" https://api.anthropic.com/v1/...` → reaches Anthropic (seeded baseline rule).
- Same against `https://example.com` → CONNECT returns `403` with `x-onecli-policy: blocked` and the JSON body.
- Add an agent-scoped `allow` rule for `example.com` (via API in Phase 3 or DB), invalidate cache → now reaches it.
- Set the agent's `policy_mode = 'allow'` (DB) → any host reachable.

Document the observed results in the PR description. No commit.

---

## Phase 3 — Management API (TypeScript)

> Allow-list **entries** already work: `POST/PATCH/DELETE /rules` accept `action: "allow"`, optional `agentId`, and `hostPattern` (`validations/policy-rule.ts`), and `createPolicyRule` forces `agentId = null` for org scope and honors `agentId` for project scope. Only the per-agent **mode** endpoint is missing.

### Task 7: Validation for per-agent policy mode

**Files:**
- Modify: `packages/api/src/validations/agent.ts`

- [ ] **Step 1: Add the schema**

Append to `agent.ts`:

```ts
import { policyModeSchema } from "./policy-rule";

export const agentPolicyModeSchema = z.object({
  // null clears the override → agent inherits the org default
  policyMode: policyModeSchema.nullable(),
});
```

(`policyModeSchema` is `z.enum(["allow", "deny"])` in `validations/policy-rule.ts`; `.nullable()` adds the inherit case.)

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @onecli/api check-types`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/validations/agent.ts
git commit -m "feat(api): add agentPolicyModeSchema"
```

### Task 8: Service to update per-agent policy mode

**Files:**
- Modify: `packages/api/src/services/agent-service.ts` (mirror `updateAgentSecretMode:260`)

- [ ] **Step 1: Add the service function**

After `updateAgentSecretMode`, add:

```ts
export const updateAgentPolicyMode = async (
  projectId: string,
  agentId: string,
  policyMode: "allow" | "deny" | null,
) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, projectId },
    select: { id: true },
  });

  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");

  await db.agent.update({
    where: { id: agentId },
    data: { policyMode },
  });
};
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @onecli/api check-types`
Expected: no errors (`ServiceError` is already imported in this file).

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/services/agent-service.ts
git commit -m "feat(api): updateAgentPolicyMode service"
```

### Task 9: `PATCH /agents/:agentId/policy-mode` route

**Files:**
- Modify: `packages/api/src/routes/agents.ts` (mirror the secret-mode route at `:114`)

- [ ] **Step 1: Import the new service + schema**

Add `updateAgentPolicyMode` to the service import block and `agentPolicyModeSchema` to the validations import block at the top of `agents.ts`.

- [ ] **Step 2: Add the route**

After the `PATCH /:agentId/secret-mode` handler (`:114-134`), add:

```ts
  // PATCH /agents/:agentId/policy-mode
  app.patch("/:agentId/policy-mode", async (c) => {
    const auth = c.get("auth");
    const agentId = c.req.param("agentId");
    const body = await c.req.json().catch(() => null);
    const parsed = agentPolicyModeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }

    await updateAgentPolicyMode(
      requireProjectId(auth),
      agentId,
      parsed.data.policyMode,
    );
    invalidateGatewayCache(c.req.raw);
    return c.json({ success: true });
  });
```

- [ ] **Step 3: Type-check + lint**

Run: `pnpm --filter @onecli/api check-types && pnpm --filter @onecli/api lint`
Expected: no errors.

- [ ] **Step 4: Manual API check**

Run (with an `oc_` API key + project header), expecting `{"success":true}` and that the gateway cache was invalidated:

```bash
curl -X PATCH "$ONECLI_URL/v1/agents/<agentId>/policy-mode" \
  -H "Authorization: Bearer $ONECLI_API_KEY" -H "x-project-id: <projectId>" \
  -H 'content-type: application/json' -d '{"policyMode":"deny"}'
```

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/agents.ts
git commit -m "feat(api): PATCH /agents/:id/policy-mode endpoint"
```

## Phase 4 — Web UI

### Task 10: Surface the `allow` action in the rules UI

**Files:**
- Modify: `apps/web/src/app/(dashboard)/rules/_components/custom-endpoint-form.tsx`
- Modify: `apps/web/src/app/(dashboard)/rules/_components/rule-card.tsx`

- [ ] **Step 1: Add `allow` to the action options in the custom-endpoint form**

Open `custom-endpoint-form.tsx` and find the array/list of selectable actions (the control whose values are `"block" | "rate_limit" | "manual_approval"`). Add an `allow` option:

```tsx
{ value: "allow", label: "Allow", description: "Permit this host/path (allow list entry)" },
```

Ensure the form submits `action: "allow"` with `hostPattern` (and optional `agentId`); rate-limit fields stay hidden for `allow`. The action enum in `validations/policy-rule.ts` already accepts `"allow"`, so no validation change is needed.

- [ ] **Step 2: Render allow rules in `rule-card.tsx`**

In `rule-card.tsx`, add a visual treatment for `action === "allow"` (e.g. a green/permissive badge alongside the existing block/rate-limit/approval badges) so allow-list entries are distinguishable.

- [ ] **Step 3: Type-check, lint, format**

Run: `pnpm --filter @onecli/web check-types && pnpm --filter @onecli/web lint`
Expected: no errors.

- [ ] **Step 4: Manual UI check**

Run: `pnpm dev`; open `/rules`; create a custom-endpoint rule with action **Allow** and a host; confirm it saves and the card shows the allow badge.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(dashboard)/rules/_components/custom-endpoint-form.tsx" "apps/web/src/app/(dashboard)/rules/_components/rule-card.tsx"
git commit -m "feat(web): surface allow rules in the rules UI"
```

### Task 11: Per-agent policy-mode action + API client

**Files:**
- Modify: `apps/web/src/lib/actions/agents.ts`
- Modify: `apps/web/src/lib/api/agents.ts` (client used by hooks)

- [ ] **Step 1: Add a server action for per-agent mode**

In `lib/actions/agents.ts`, add (follow the `withAudit` + `resolveProjectContext` pattern used elsewhere; reuse `updateAgentPolicyMode` from the API service and invalidate the gateway cache):

```ts
"use server";
import { updateAgentPolicyMode as updateAgentPolicyModeService } from "@onecli/api/services/agent-service";
import { resolveProjectContext } from "@/lib/actions/resolve-user";
import { invalidateGatewayCacheForOrg } from "@onecli/api/lib/gateway-invalidate";

export const setAgentPolicyMode = async (
  agentId: string,
  policyMode: "allow" | "deny" | null,
): Promise<void> => {
  const { projectId, organizationId } = await resolveProjectContext();
  await updateAgentPolicyModeService(projectId, agentId, policyMode);
  invalidateGatewayCacheForOrg(organizationId);
};
```

If `lib/actions/agents.ts` does not exist, create it; otherwise append. (Match the existing import style — some actions import services from `@onecli/api/services/...`.)

- [ ] **Step 2: Add a client method (if the agent UI uses a REST client rather than the action)**

In `lib/api/agents.ts`, add a method calling `PATCH /agents/:id/policy-mode` consistent with the existing secret-mode client method. If the agent components call server actions directly, skip this step.

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @onecli/web check-types`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib
git commit -m "feat(web): server action + client for per-agent policy mode"
```

### Task 12: Network-access dialog on the agent card

**Files:**
- Create: `apps/web/src/app/(dashboard)/agents/_components/network-access-dialog.tsx`
- Modify: `apps/web/src/app/(dashboard)/agents/_components/agent-card.tsx`

- [ ] **Step 1: Build the dialog**

Create `network-access-dialog.tsx` (one component per file). Use the `manage-access-dialog.tsx` in the same folder as the structural template (Dialog + form + save). It must:
- Show a mode control with three choices: **Inherit org default** (`null`), **Locked — Anthropic only** (`deny`), **Open — unlimited** (`allow`); call `setAgentPolicyMode(agentId, mode)` on change.
- When mode is `deny`, show an **Allowed domains** editor: list this agent's `allow` rules (`agentId === agent.id`), an input to add a host pattern (calls the existing `createRule` action with `{ name, hostPattern, action: "allow", enabled: true, agentId }`), and a remove control per entry (calls `deleteRule`). Reuse `getRules`/`createRule`/`deleteRule` from `lib/actions/rules.ts`.

```tsx
"use client";

import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { setAgentPolicyMode } from "@/lib/actions/agents";

type Mode = "allow" | "deny" | null;

export interface NetworkAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentName: string;
  policyMode: Mode;
}

export const NetworkAccessDialog = ({
  open, onOpenChange, agentId, agentName, policyMode,
}: NetworkAccessDialogProps) => {
  const [mode, setMode] = useState<Mode>(policyMode);
  const [saving, setSaving] = useState(false);

  const choose = async (next: Mode) => {
    setSaving(true);
    setMode(next);
    await setAgentPolicyMode(agentId, next);
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Network access — {agentName}</DialogTitle>
          <DialogDescription>
            Control which domains this agent can reach.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Button variant={mode === null ? "default" : "outline"} disabled={saving} onClick={() => choose(null)}>
            Inherit organization default
          </Button>
          <Button variant={mode === "deny" ? "default" : "outline"} disabled={saving} onClick={() => choose("deny")}>
            Locked — Anthropic only
          </Button>
          <Button variant={mode === "allow" ? "default" : "outline"} disabled={saving} onClick={() => choose("allow")}>
            Open — unlimited
          </Button>
        </div>
        {mode === "deny" ? (
          <AllowedDomainsEditor agentId={agentId} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
```

Implement `AllowedDomainsEditor` in the same file's sibling file if it grows large; for now an inline sub-component is acceptable since it is the dialog's single concern. It lists/add/removes agent-scoped `allow` rules via the rules actions above.

- [ ] **Step 2: Wire a trigger into `agent-card.tsx`**

In `agent-card.tsx`, add a "Network access" action (menu item or button) that opens `NetworkAccessDialog` with the agent's `id`, `name`, and `policyMode`. Ensure the agents list query selects `policyMode` (update the agents fetch/select if it does not already include it).

- [ ] **Step 3: Type-check, lint, format**

Run: `pnpm --filter @onecli/web check-types && pnpm --filter @onecli/web lint && pnpm run format:check`
Expected: no errors.

- [ ] **Step 4: Manual UI check**

Run: `pnpm dev`; on `/agents`, open Network access for an agent; switch to **Locked**, add `api.github.com` as an allowed domain, confirm it appears; switch to **Open** and back; confirm changes persist after reload.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(dashboard)/agents/_components/network-access-dialog.tsx" "apps/web/src/app/(dashboard)/agents/_components/agent-card.tsx"
git commit -m "feat(web): per-agent network access dialog with allowed domains editor"
```

---

## Final verification

- [ ] **Run the full check + tests**

Run from repo root: `pnpm check && pnpm test`
Expected: lint, type-check, format, and `cargo test` all pass.

- [ ] **Confirm spec coverage** (see Self-Review below) and write PR notes documenting the new deny-by-default for new orgs and how to add allow rules.

---

## Self-Review (completed during planning)

**Spec coverage:**
- Per-agent mode (inherit/deny/allow) → Tasks 1, 8, 9, 11, 12 ✓
- Allow list as Allow PolicyRules, global vs per-agent → reuse (Phase 3 note) + Tasks 10, 12 ✓
- Single enforcement path → Tasks 3, 4, 5 (one `evaluate`, one CONNECT gate) ✓
- AI backends reachable via managed credentials (no seeded rule) → Tasks 3, 5 ✓
- Enforcement fix (deny blocks unknown hosts) → Tasks 3, 4 ✓
- CONNECT-time blocking, no tunnel → Task 5 ✓
- New-default-deny, existing orgs pinned to allow → Task 1 (existing rows keep prior `allow`; default flips) ✓
- Management API for nanoclaw → Tasks 7-9 (mode) + existing rules API (entries) ✓
- Web UI → Tasks 10-12 ✓
- Structured 403 contract → Task 5 (`connect_blocked`, `x-onecli-policy` header) ✓

**Confirmed design decision:** credentials configured for a host count as an implicit allow in deny mode (Tasks 3, 5), so AI backends and connected apps are reachable by having a managed credential — no seeded baseline rule. Trade-off accepted: an agent passing its *own* key directly (no OneCLI-managed injection) is blocked in deny mode until an explicit allow rule is added.

**Open items carried from the spec (verify during implementation):** whether any LLM-traffic logging depended on `is_llm_host` (grep showed only the two enforcement call sites); org- vs project-level scope for the global list (org assumed).
