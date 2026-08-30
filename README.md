# whoopcp

Read-only MCP server for one WHOOP account. A Cloudflare Worker fetches recovery, sleep, strain, and workouts. Coaching stays in Grok.

WHOOP is authorized once. Tokens live in Workers KV and refresh themselves. Reconnect only if `/health` says `whoop_connected: false` or a tool returns `WHOOP disconnected`.

If you are an agent, follow **Install** in order. The committed `wrangler.jsonc` belongs to the original author. Leaving it unchanged deploys against their KV and sends OAuth to `whoop.portalier.org`.

## Tools

| Tool | Use |
| --- | --- |
| `ping` | Liveness. Does not call WHOOP. |
| `get_profile` | Name, height, weight, max HR (never email) |
| `get_latest` | Today's recovery, last night's sleep, current strain |
| `get_day` | One calendar date |
| `list_recoveries` | Recovery / HRV / RHR rows |
| `list_sleep` | Sleep rows and stages |
| `list_workouts` | Sessions by sport |
| `summarize_range` | Weekly/block averages (max 90 days) |

## Two secrets

Do not mix these up.

| Secret | Where | When |
| --- | --- | --- |
| `CONNECT_TOKEN` | `/connect` form | Once, to bind WHOOP. Also `POST /disconnect`. |
| `MCP_TOKEN` | `Authorization: Bearer` on `/mcp` | Every Grok / inspector / xAI call. Store it in the client. |

The Worker also accepts `MCP_TOKEN` in `X-MCP-Token` or `X-Api-Key`. Visiting `/connect` always shows the form, even when already connected. Filling it overwrites the stored WHOOP tokens.

Production without `MCP_TOKEN` returns 503. Do not open `/mcp` to the world.

## Install

Work in a clone of this repo. The GitHub remote may be private. If clone fails, ask the human for the source tree and continue from there.

### 0. Human gates

You cannot finish without these. Stop and ask if any are missing.

1. Node.js 22 or newer. `node -v`. Wrangler 4 exits on Node 20.
2. A Cloudflare account. The human runs `npx wrangler login` in a terminal that can open a browser, then you run `npx wrangler whoami`. A `CLOUDFLARE_API_TOKEN` with Workers Scripts Edit and Workers KV Edit also works.
3. A WHOOP account with scored data.
4. The human will create the WHOOP developer app in a browser **after** you have the public Worker URL. Do not guess the callback.

### 1. Install packages

```bash
npm install
npx wrangler whoami
```

If `whoami` fails, stop. Login is a browser step.

### 2. Replace KV ids in wrangler.jsonc

```bash
CI=true npx wrangler kv namespace create WHOOP_TOKENS
CI=true npx wrangler kv namespace create WHOOP_TOKENS --preview
```

Prefix with `CI=true` so Wrangler does not interactively offer to patch the config. It can append a duplicate binding on top of the author's. You will edit the file yourself.

Each command prints an id. Overwrite `kv_namespaces[0].id` with the non-preview id and `kv_namespaces[0].preview_id` with the preview id. Keep `"binding": "WHOOP_TOKENS"`. Do not add a second `kv_namespaces` entry. Do not pass `--update-config`.

If Wrangler asks which Cloudflare account, stop and ask the human. Set `CLOUDFLARE_ACCOUNT_ID` to their choice.

Leave `vars.WHOOP_REDIRECT_URI` until you have the Worker URL.

### 3. Put MCP and connect secrets

Bare `wrangler secret put` prompts and hangs an agent. Always pipe. Print both values to the human once so they can store them.

```bash
MCP_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
CONNECT_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
printf '%s' "$MCP_TOKEN" | npx wrangler secret put MCP_TOKEN
printf '%s' "$CONNECT_TOKEN" | npx wrangler secret put CONNECT_TOKEN
```

Do not commit these. Do not put WHOOP client secrets yet.

### 4. Deploy, then set the callback to the real host

```bash
npx wrangler deploy
```

Copy the `https://whoopcp.<subdomain>.workers.dev` URL from the deploy output. The subdomain is not the Cloudflare account name. Do not invent it. If deploy says the workers.dev subdomain is missing, the human enables it under Workers in the Cloudflare dashboard, then you deploy again.

Call that origin `$HOST` with no trailing slash. Set `vars.WHOOP_REDIRECT_URI` in `wrangler.jsonc` to `$HOST/whoop/callback` exactly, then:

```bash
npx wrangler deploy
```

A custom domain is fine instead of workers.dev. Then `$HOST` is that origin, and the same path rules apply. Do not leave `whoop.portalier.org` in the file.

### 5. Human creates the WHOOP app

Give them these exact fields. You cannot submit the dashboard.

Open https://developer-dashboard.whoop.com/apps/create. Create a team if the dashboard asks.

| Field | Value |
| --- | --- |
| Name | whoopcp, or any name they want on the consent screen |
| Contacts | their email |
| Privacy policy | `$HOST/privacy` |
| Redirect URIs | `$HOST/whoop/callback` and `http://localhost:8787/whoop/callback` |
| Scopes | `offline`, `read:recovery`, `read:cycles`, `read:workout`, `read:sleep`, `read:profile`, `read:body_measurement` |
| Webhook | leave empty |

Redirect URIs must match `WHOOP_REDIRECT_URI` character for character. Personal use stays under WHOOP's 10-member dev cap. No app approval needed.

They paste Client ID and Client Secret back to you.

```bash
printf '%s' "$WHOOP_CLIENT_ID" | npx wrangler secret put WHOOP_CLIENT_ID
printf '%s' "$WHOOP_CLIENT_SECRET" | npx wrangler secret put WHOOP_CLIENT_SECRET
```

No extra deploy after `secret put`.

### 6. Human connects WHOOP

Open `$HOST/connect`, paste `CONNECT_TOKEN`, consent. Then:

```bash
curl "$HOST/health"
```

Expect `{"ok":true,"whoop_connected":true}`. `/health` only checks that a KV blob exists. It does not prove the refresh token still works. A Worker cron refreshes at minute 0 and 45.

Do not open `/connect` before WHOOP secrets are set.

### 7. Wire a client that can send a bearer header

This server is static bearer auth. It is not an MCP OAuth provider.

**Grok TUI / Grok Build.** This is the path that actually sends a header.

```bash
export WHOOP_MCP_TOKEN='<MCP_TOKEN>'
grok mcp add --transport http whoop "$HOST/mcp" \
  --header "Authorization: Bearer ${WHOOP_MCP_TOKEN}"
grok mcp doctor whoop
```

Same thing in `~/.grok/config.toml`. Older docs said `mcp.toml`. That file is ignored.

```toml
[mcp_servers.whoop]
url = "https://whoopcp.<subdomain>.workers.dev/mcp"
headers = { "Authorization" = "Bearer ${WHOOP_MCP_TOKEN}" }
```

`bearer_token_env_var = "WHOOP_MCP_TOKEN"` is equivalent if you prefer that field.

**Cursor.** Merge a `whoop` entry into `~/.cursor/mcp.json` so the token is not committed. Do not overwrite other servers. Do not put the token in the project `.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "whoop": {
      "url": "https://whoopcp.<subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_TOKEN>"
      }
    }
  }
}
```

**xAI API.**

```python
mcp(
    server_url="https://whoopcp.<subdomain>.workers.dev/mcp",
    server_label="whoop",
    authorization="<MCP_TOKEN>",
)
```

The Worker accepts a raw token or `Bearer <token>`. Prefer the raw secret in `authorization`.

**grok.com custom connector.** [grok.com/connectors](https://grok.com/connectors) → New Connector → Custom. Paste `$HOST/mcp`. If the UI has a token or header field, use `MCP_TOKEN`. If it asks for OAuth client id, authorize URL, or metadata, stop. This Worker has none of that. Use Grok TUI or xAI instead. Do not remove `MCP_TOKEN` to make the connector "just work".

Smoke test: call `ping`, then ask a coaching question that should call `get_latest`.

## Local

```bash
cp .dev.vars.example .dev.vars
# fill WHOOP_* , MCP_TOKEN, CONNECT_TOKEN
# WHOOP_REDIRECT_URI is already localhost in the example
npx wrangler dev
npx @modelcontextprotocol/inspector@latest
# URL: http://localhost:8787/mcp
# Header: Authorization: Bearer <MCP_TOKEN>
```

`MCP_TOKEN` may be omitted only on localhost. Production without it returns 503.

## If something fails

| What you see | Likely cause |
| --- | --- |
| Wrangler demands Node 22 | `node -v` is 20 or older |
| KV namespace does not belong to this account | `wrangler.jsonc` still has the author's ids |
| OAuth callback hits `whoop.portalier.org` or WHOOP says redirect mismatch | `WHOOP_REDIRECT_URI` was not set to `$HOST/whoop/callback`, or the dashboard URI differs |
| `wrangler secret put` waits for input | You did not pipe the value |
| `CONNECT_TOKEN not configured` | Connect secret was never put |
| `MCP_TOKEN not configured` | MCP secret was never put. Production returns 503. |
| `/mcp` 401 | Wrong token, or the client is not sending a header |
| grok.com asks for OAuth | Use `grok mcp add --header` instead |
| `/health` has `whoop_connected: false` | `/connect` never completed, or you are bound to the wrong KV namespace |
| WHOOP connect HTML says failed | Redirect URI mismatch, or `/connect` ran before WHOOP secrets existed |

## Scripts

```bash
npm test
npm run check
npm run types
npm run dev
npm run deploy
```

Design notes: `DESIGN.md`.
