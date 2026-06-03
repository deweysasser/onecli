# Network Access Policy

OneCLI's gateway is a **per-agent network allow list**. By default an agent can
only reach the hosts it actually needs — every other destination is blocked at
the proxy before a connection is ever opened. Access is controlled per agent,
with an organization-wide default, and is enforced by the same policy engine
that already governs credential injection.

## Why

OneCLI already keeps raw credentials away from agents — the gateway injects them
at request time so the agent never sees a secret (see the
[README](../README.md) and [Vault Integration](vault-integration.md)). Network
access policy is the other half of that containment story: controlling **where
an agent is allowed to talk**, not just what it carries.

An AI agent is partly driven by untrusted input — the documents it reads, the
tool output it ingests, the web pages it fetches. Prompt injection, a poisoned
dependency, or a confused-deputy bug can all turn an agent into something that
tries to phone home: exfiltrating data to an attacker's server, pulling a second
-stage payload, or hitting an internal service it was never meant to touch.
Hiding the credentials doesn't stop that — the agent can still open a socket to
anywhere.

Egress control closes the gap. If an agent can only reach an explicit set of
hosts, then **even a fully compromised agent can't ship your data to an
arbitrary endpoint** or reach laterally into your network. The two controls
compose: the gateway decides _what credential_ a request may use **and** _what
host_ it may reach. Default-deny means a new agent starts locked down and is
opened up deliberately, host by host, rather than being open by default and
locked down only if someone remembers to.

## Mental model

Every agent resolves to one of three states. All three are expressed through the
existing policy storage — there is no separate allow-list system.

| State                | How it's set                            | Behavior                                                                 |
| -------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| **Locked** (default) | `policyMode = deny`, no allow rules     | Only hosts the agent holds a OneCLI-managed credential for are reachable |
| **Allow-listed**     | `policyMode = deny` + agent allow rules | Credentialed hosts **plus** named domains                                |
| **Open**             | `policyMode = allow`                    | Unlimited — any host                                                     |

`policyMode` lives on the **organization** (the default for all its agents) and,
optionally, on each **agent** (an override; unset = inherit the org default).
The gateway resolves the effective mode as `agent.policyMode ?? org.policyMode`.

## How a host becomes reachable in deny mode

In a locked-down (deny) agent, a destination host is allowed if **any** of the
following is true — otherwise it is blocked:

1. **The agent is Open.** `policyMode = allow` means no host filtering at all.
2. **You've granted the agent a credential for that host.** This is
   _credentials-imply-allow_: if a secret or app connection whose host pattern
   matches the destination is injected for this agent, the host is reachable —
   because the whole point of the credential is to let the agent use that
   service. No separate allow rule is needed, and nothing is auto-seeded. An
   agent with an Anthropic API key can reach `api.anthropic.com` simply by
   having the key; give it nothing and it reaches nothing.
3. **An explicit allow rule matches.** An `Allow` policy rule whose host pattern
   matches the destination, scoped either to the agent or globally
   (organization-wide). Use this for hosts you want reachable **without**
   injecting a credential (a public API, a docs site, an internal service).

Credential grants are per agent and selective: a credential that exists in the
organization but is **not** granted to a given agent does **not** open that host
for it. So two agents in the same org can have very different reach even with
the same secrets defined.

### Host patterns

Allow-rule and credential host patterns match the request host
case-insensitively and support:

- **Exact** — `api.hardcover.app` matches only that host.
- **Wildcard subdomain** — `*.nytimes.com` matches `www.nytimes.com` and
  `api.nytimes.com`, but **not** the apex `nytimes.com` and **not**
  `notnytimes.com`. The pattern must be `*.` followed by the domain; a bare `*`
  prefix without the dot (e.g. `*nytimes.com`) is rejected and does not
  superset-match.
- **`*`** — matches everything (used by block-all / rate-limit-all rules; the UI
  steers you to Open mode instead for allow).

## What a blocked request looks like

Enforcement happens at **CONNECT** time, before any tunnel is opened, so a
disallowed destination never receives a connection.

- **Blocked host** → `403 Forbidden` on the CONNECT, with header
  `x-onecli-policy: blocked` and `x-should-retry: false`, and a JSON body the
  CLI/agent can surface:

  ```json
  {
    "error": "blocked_by_default_policy",
    "message": "evil.example.com is not on this agent's network allow list. Add it in your OneCLI dashboard or set the agent to open.",
    "host": "evil.example.com",
    "dashboard_url": "http://localhost:10254/rules?create=allow&host=evil.example.com"
  }
  ```

- **Missing or invalid agent token** → `407 Proxy Authentication Required` with a
  `Proxy-Authenticate` header. The gateway requires every request to identify an
  agent; it will not proxy anonymously.

For an allowed host, the CONNECT tunnel is established and the request proceeds
through the normal request-level policy passes (block / manual-approval /
rate-limit on specific paths) and credential injection.

## Configuring it

### Web dashboard (http://localhost:10254)

- **Organization default** — **Settings → Network Access Policy**. Choose
  _Locked_ (deny) or _Open_ (allow) as the default for new agents.
- **Per-agent mode** — on an agent, **Network access**: _Inherit_, _Locked_, or
  _Open_. Locked agents also get an **Allowed domains** editor for adding
  agent-scoped allow rules (host patterns).
- **Per-agent credentials** — the agent's **Credential access** dialog controls
  which secrets/app connections are injected for it (All, or Selective). Because
  of credentials-imply-allow, granting a credential here also makes its host
  reachable.
- **Global allow rules** — the **Rules** page manages organization-wide `Allow`
  rules (host pattern, no `agentId`) that apply to every agent.

### Management API

Orchestrators (e.g. nanoclaw) configure all of this at provisioning time via the
REST API — see [nanoclaw-integration.md](nanoclaw-integration.md):

- **Per-agent mode:** `PATCH /agents/:agentId/policy-mode` with
  `{ "policyMode": "allow" | "deny" | null }` (`null` = inherit the org default).
- **Allow entries:** the rules endpoints (`POST` / `PATCH` / `DELETE /rules`)
  accept `action: "allow"`, an optional `agentId` (omit for a global rule), and a
  `hostPattern`.

All mutations are audited, and changing a mode or rule invalidates the gateway's
policy cache so it takes effect promptly.

## Testing it live

An agent authenticates to the gateway (port `10255`) as an HTTP proxy, using its
access token as the proxy password. The gateway intercepts TLS with its own CA,
so point the client at that CA (or install it in the agent's trust store):

```bash
# the gateway's CA cert (for HTTPS interception)
docker exec onecli cat /app/data/gateway/ca.pem > /tmp/onecli-ca.pem

# allowed host → CONNECT tunnels, you get the upstream response
curl -x http://x:YOUR_AGENT_TOKEN@localhost:10255 --cacert /tmp/onecli-ca.pem \
     https://api.hardcover.app/

# blocked host → 403 at CONNECT, no tunnel opened
curl -v -x http://x:YOUR_AGENT_TOKEN@localhost:10255 --cacert /tmp/onecli-ca.pem \
     https://example.com/ 2>&1 | grep -i '403\|x-onecli-policy'
```

A blocked request shows `HTTP/1.1 403` and `x-onecli-policy: blocked`; an allowed
one establishes the tunnel and returns the upstream status.

## Rollout & compatibility

- **New organizations default to `deny`** — locked down, opened up deliberately.
- **Existing organizations were pinned to `allow`** by the rollout migration, so
  upgrading changes nothing for current agents until you opt them into deny.
- Switching an org (or agent) to deny is the moment egress control turns on;
  expect to add credentials and/or allow rules for the hosts each agent needs.

## Design reference

The full design rationale and the enforcement internals are in the design spec:
[`docs/superpowers/specs/2026-05-28-per-agent-network-allowlist-design.md`](superpowers/specs/2026-05-28-per-agent-network-allowlist-design.md).

Key files:

| File                                   | Role                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| `apps/gateway/src/policy.rs`           | Policy evaluation — deny-by-default pass, credentials-imply-allow |
| `apps/gateway/src/connect.rs`          | `host_allowed_at_connect`, host-pattern matching                  |
| `apps/gateway/src/gateway.rs`          | CONNECT-time gate; anonymous-request rejection                    |
| `apps/gateway/src/gateway/response.rs` | Blocked (403) and auth-required (407) responses                   |
| `apps/gateway/src/db.rs`               | Effective-mode resolution (`COALESCE(agent, org)`)                |
| `packages/api/src/routes/agents.ts`    | `PATCH /agents/:id/policy-mode`                                   |
| `packages/db/prisma/schema.prisma`     | `Organization.policyMode`, `Agent.policyMode`                     |
