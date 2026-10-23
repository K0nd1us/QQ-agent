# Optional headless runtime module

[中文](README.md)

This opt-in module separates Linux/container startup, protocol transports and console authentication from the 0.4 application. It reuses the existing archive, orchestrator, models, memory, tools and console. Electron, Windows QQ and bundled SnowLuma are not required; an independent protocol service owns the QQ login.

This is a trusted bootstrap module, **not** a hot-loaded chat plugin or Skill. Listeners, authentication and transports must be assembled before application startup. Only trusted code can supply `createApp({ runtime })`; ordinary plugin permissions are unchanged. Existing `npm start`, `npm run server`, Windows installation scripts and the default client retain their original paths. This module does not modify `0.5(unfinished)/`.

## Structure and composition contract

```js
import { createHeadlessApp } from './modules/headless/index.js';
const app = createHeadlessApp();
await app.start();
// Call await app.stop() on shutdown.
```

| File | Responsibility |
| --- | --- |
| `index.js` | Composition, validation, connection replacement and scheduler recovery |
| `connection.js` | Stable connection reference, enable switch and transport selection |
| `onebot.js` | Forward/reverse OneBot 11 WS, WS/HTTP APIs, authentication, echo and disconnect cleanup |
| `qqbot.js` | Optional official QQBot Gateway adapter, independent of OneBot transport |
| `console.js` | Console token, HttpOnly sessions, SSE and Host/Origin checks |
| `server.js` | Process entry, SIGINT/SIGTERM and failed-start cleanup |
| `Dockerfile`, `compose.yaml` | Non-root runtime, health checks, persistence and log rotation |

Core integration consists of explicit hooks: `createConnection`, `attach`, `listenOptions`, `authorize`, `originAllowed`, `handleRequest`, `status`, `validateConfig`, `configChanged` and `stop`. These are internal 0.4 composition seams, not a promise of a version-independent plugin SDK.

## Run with Node.js

Use Node.js 22 or 24 and enter `0.4/` from the repository root:

```sh
cd 0.4
npm ci --omit=dev --ignore-scripts
export QQ_AGENT_DATA_DIR=/absolute/private/data
export QQ_AGENT_TOKEN='replace-with-your-random-console-token'
npm run server:headless
```

Prepare a private data directory writable by the service user first. The default console address is `127.0.0.1:3210`. Visit `/runtime/connection` to configure the protocol, and `/` for models, allowlists, personas and other existing console features. Sign in with the console token. Browser requests and SSE use an HttpOnly cookie; console tokens are not put in URLs.

`QQ_AGENT_HOST`, `QQ_AGENT_PORT`, `QQ_AGENT_TOKEN` and `QQ_AGENT_ALLOWED_HOSTS` override runtime settings without being persisted in `config.json`. Non-loopback request Hosts must be explicitly allowed, for example `bot.example.test:3210`; supplied Origin/Referer must match the Host. SSH forwarding is suitable for remote access; internet-facing reverse proxies should provide HTTPS.

## Docker Compose

Run from `0.4/`:

```sh
umask 077
cp modules/headless/.env.example .env
# Edit .env and replace the console token; openssl rand -hex 32 can generate one.
docker compose --env-file .env -f modules/headless/compose.yaml up -d --build --wait
docker compose --env-file .env -f modules/headless/compose.yaml logs -f agent
```

The published port defaults to host loopback. To permit another host, configure both the bind address and allowed Host values. Never commit `.env`. The default base is Node 22 Debian slim; the `NODE_IMAGE` build argument accepts an audited base image or pinned digest.

Data, user plugins and user Skills use three separate volumes. The image does not include QQ, a protocol service, real accounts, API keys, conversations or private deployment settings. Desktop and container instances must not write to the same live data directory. Extensions may need additional system dependencies such as ffmpeg; this base image does not claim universal third-party extension compatibility.

### OneBot connections

- Forward mode connects to the protocol service's `wsUrl`; APIs can use that socket or a separate HTTP endpoint.
- Reverse mode waits on `/onebot/v11/ws` by default. A protocol access token is mandatory. Configure the protocol service with `Authorization: Bearer <protocol-token>` and the Universal role.
- Services on a shared Compose network can connect to `ws://agent:3210/onebot/v11/ws`. Separate Compose projects must explicitly share a Docker network; container loopback does not refer to another container.
- Console and protocol tokens are separate. The module does not scan protocol configuration files or install/start/stop external QQ services. Explicit legacy `snowluma` credentials can be mapped to forward WS + HTTP without deleting or rewriting the legacy fields. Fresh installs keep connections disabled until explicitly enabled.

Settings live in a separate `connection` section. This example contains placeholders only:

```json
{
  "connection": {
    "enabled": true,
    "type": "onebot",
    "onebot": {
      "mode": "reverse",
      "apiTransport": "ws",
      "reversePath": "/onebot/v11/ws",
      "accessToken": "replace-with-your-protocol-token"
    }
  }
}
```

The existing `/api/config` endpoint validates before persistence and reconnects afterward. Old active runs are cancelled individually before scheduling and timers are restored, preventing the connected-but-never-replies failure after configuration changes. Disconnects and timeouts can leave send outcomes unknown; message sends are never automatically replayed by the transport.

### Optional official QQBot adapter

Select the official bot type and provide an AppID/AppSecret with Gateway access. The adapter implements credential caching, Identify/Resume, heartbeats and group/C2C/channel event normalization, with replies restricted to received-message windows. It does not implement a Webhook receiver or establish account eligibility for Gateway access. Unsupported OneBot extensions fail explicitly. OpenID strings are preserved separately from numeric QQ identifiers. Mock protocol coverage does not constitute real-account or platform-policy acceptance.

Legacy SnowLuma/portable-QQ process-management endpoints return an explicit 409 under this module; use the independent protocol service's management UI. Existing telemetry, price-feed, community-sync and extension network behavior is unchanged.

## Verification and migration

```sh
npm run test:headless
docker build --target test -t qq-agent-headless-test -f modules/headless/Dockerfile .
docker run --rm --network none qq-agent-headless-test
```

Tests use synthetic identities, isolated temporary data, mock OneBot and mock LLM services. Non-loopback fetches are rejected. Coverage includes authentication/SSE, disabled access, OpenID persistence, both WS directions, echo/error/timeout handling, private/group replies after reconfiguration, cancellation of in-flight model calls and SIGTERM cleanup. Tests do not sign in to QQ, send real messages or call paid models. The Docker test container also has no external network.

A real deployment must separately verify QQ login, transport readiness, ingress, model access, actual delivery, media paths and persistence across restarts. Validate in separate directories/volumes before a cutover. Do not overwrite desktop data or hand 0.4 data directly to 0.5. Back up the application revision and quiesced data/extensions; restore matching versions when rolling back.
