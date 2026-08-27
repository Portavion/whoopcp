# whoopcp

Read-only MCP server for one WHOOP account. A Cloudflare Worker fetches recovery, sleep, strain, and workouts. Coaching stays in Grok.

WHOOP is authorized once. Tokens live in Workers KV and refresh themselves. You do not reconnect unless `/health` says `whoop_connected: false` or a tool returns `WHOOP disconnected`.

After deploy, the MCP URL is `https://whoopcp.<account>.workers.dev/mcp` (or your custom domain).

## Tools

| Tool | Use |
| --- | --- |
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
| `CONNECT_TOKEN` | `/connect` form | Once, to bind WHOOP. Also `/disconnect`. |
| `MCP_TOKEN` | `Authorization: Bearer` on `/mcp` | Every Grok / inspector / xAI call. Store it in the client. |

Visiting `/connect` always shows the form, even when already connected. That is a rebind gate, not a login session. Filling it overwrites the stored WHOOP tokens.

## Setup

1. Create a WHOOP app at [developer-dashboard.whoop.com/apps/create](https://developer-dashboard.whoop.com/apps/create).

   Scopes: `offline read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement`.

   Redirect URIs:
   - production callback (`https://whoopcp.<account>.workers.dev/whoop/callback`, or your custom domain)
   - `http://localhost:8787/whoop/callback`

2. Cloudflare account. `npm install`

3. KV:

```bash
npx wrangler kv namespace create WHOOP_TOKENS
npx wrangler kv namespace create WHOOP_TOKENS --preview
```

Put the ids in `wrangler.jsonc`. Set `vars.WHOOP_REDIRECT_URI` to the production callback.

4. Secrets:

```bash
openssl rand -hex 32   # MCP_TOKEN
openssl rand -hex 32   # CONNECT_TOKEN
npx wrangler secret put WHOOP_CLIENT_ID
npx wrangler secret put WHOOP_CLIENT_SECRET
npx wrangler secret put MCP_TOKEN
npx wrangler secret put CONNECT_TOKEN
```

5. Deploy and connect:

```bash
npx wrangler deploy
# open https://whoopcp.<account>.workers.dev/connect
# paste CONNECT_TOKEN in the form, consent in WHOOP
curl https://whoopcp.<account>.workers.dev/health
```

Expect `{"ok":true,"whoop_connected":true}`. `/health` only checks that a KV blob exists. It does not prove the refresh token still works.

## Local

```bash
cp .dev.vars.example .dev.vars
# fill WHOOP_* , MCP_TOKEN, CONNECT_TOKEN, localhost redirect
npx wrangler dev
npx @modelcontextprotocol/inspector@latest
# URL: http://localhost:8787/mcp
# Header: Authorization: Bearer <MCP_TOKEN>
```

`MCP_TOKEN` may be omitted only on localhost. Production without it returns 503.

## Grok

[grok.com/connectors](https://grok.com/connectors) → New Connector → Custom → `https://whoopcp.<account>.workers.dev/mcp`. If the UI has a token field, use `MCP_TOKEN`. If it requires MCP OAuth, leave `/mcp` closed and use Grok TUI or xAI.

Grok TUI:

```bash
grok mcp add --transport http whoop https://whoopcp.<account>.workers.dev/mcp \
  --header "Authorization: Bearer ${WHOOP_MCP_TOKEN}"
```

```toml
[mcp_servers.whoop]
url = "https://whoopcp.<account>.workers.dev/mcp"
headers = { "Authorization" = "Bearer ${WHOOP_MCP_TOKEN}" }
```

xAI:

```python
mcp(
    server_url="https://whoopcp.<account>.workers.dev/mcp",
    server_label="whoop",
    authorization="<MCP_TOKEN>",
)
```

## Scripts

```bash
npm test
npm run check
npm run types
npm run dev
npm run deploy
```

Design notes: `DESIGN.md`.
