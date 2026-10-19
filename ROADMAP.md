# NetPanzer on Outiva: Implementation Roadmap

## Executive summary

NetPanzer does not need a new web client built from scratch. A substantial browser port already exists. The main work is turning that port into an Outiva-quality product with one-click matchmaking, persistent settings, faster loading, managed game-server deployment, and production monitoring.

As of 19 October 2026, the useful starting points are:

- [`browser-production`](https://github.com/netpanzer/netpanzer/tree/browser-production) compiles the C++/SDL2 game to WebAssembly and includes a WebSocket-to-TCP gateway.
- Its [browser implementation](https://github.com/netpanzer/netpanzer/tree/browser-production/support/web) has Chrome and Firefox gameplay tests, server-list integration, fullscreen handling, and deployment packaging.
- [`np-website`](https://github.com/netpanzer/np-website) demonstrates a production Django deployment, immutable releases, WebSocket bridging, server discovery, rate limits, and rollback.
- [`serverbrowser-js`](https://github.com/netpanzer/serverbrowser-js) understands the master-server and UDP status protocols and collects player statistics.
- [`masterserver`](https://github.com/netpanzer/masterserver) maintains the public server directory on TCP/UDP port 28900.

The first priority should be recovering and reproducing the existing `browser-production` build. After that, the main product task is to replace the visible server-selection flow with automatic matchmaking.

## Intended player experience

The normal Outiva flow should be:

1. Open the NetPanzer page.
2. Enter or confirm a display name on the first visit.
3. Click **Play**.
4. Outiva chooses the best compatible server.
5. The game loads directly into that server.
6. After disconnecting, offer **Play again** or **Settings**.

Players should not see IP addresses, ports, master-server settings, or a server browser during the normal flow.

Settings can contain:

- Matchmaking: `Automatic` by default
- Preferred region: `Automatic`, Europe, North America, and so on
- Preferred mode, if Outiva later runs several modes
- Graphics, sound, fullscreen, and controls
- An advanced server-selection option, deliberately kept out of the main flow
- Reset local game data

For the MVP, if there is only one Outiva server, automatic matchmaking simply chooses it. Designing the API as matchmaking from the beginning avoids redesigning the client when more servers are added.

## Target architecture

```text
Player browser
   |
   +-- HTTPS --> Outiva website/CDN
   |              +-- versioned JS, Wasm, and game assets
   |
   +-- HTTPS --> Matchmaking API
   |              +-- returns a short-lived server ticket
   |
   +-- WSS ----> Outiva game gateway
                   |
                   +-- TCP --> native NetPanzer dedicated server
                                +-- UDP status/health checks
```

The gateway is mandatory. Browsers cannot open raw TCP or UDP connections, so the existing native NetPanzer protocol must be carried through WebSockets and translated at the server edge. This is the intended pattern described by [Emscripten's networking documentation](https://emscripten.org/docs/porting/networking.html).

Keep the gateway and game server in the same region. Browser-to-gateway latency is player-facing; gateway-to-game-server latency should be almost negligible.

## Confirmed Outiva deployment topology

The public hostname is `netpanzer.outiva.com`. DNS and HAProxy route it to the
origin server at `192.168.10.181`.

HAProxy owns the public certificate and terminates the public TLS connection.
The connection from HAProxy to Apache should also use HTTPS, with an internal
origin certificate installed on `192.168.10.181`. That certificate can be
self-signed if the HAProxy backend is configured to trust it or explicitly not
verify it. It is not exposed directly to players.

```text
Internet
   |
   | HTTPS: netpanzer.outiva.com (public certificate)
   v
HAProxy
   |
   | HTTPS to 192.168.10.181:443 (internal origin certificate)
   v
Apache
   |-- static browser client files
   |-- /servers --> local NetPanzer service
   +-- /game ----> local WebSocket gateway
                         |
                         +-- TCP --> native game server
```

Apache must preserve the original host, forward the public HTTPS scheme, pass
the `/game` WebSocket upgrade and preserve its query string. Only Apache needs
to be reachable from HAProxy; the local application/gateway port should listen
on loopback and should not be exposed on the LAN.

An origin-vhost template is provided at
[`deploy/outiva/apache/netpanzer.outiva.com.conf`](deploy/outiva/apache/netpanzer.outiva.com.conf).

The target repository is
[`johnsie/netpanzer-ng`](https://github.com/johnsie/netpanzer-ng). It was empty
when inspected on 19 October 2026, so the initial import should preserve the
upstream NetPanzer history rather than beginning with a source-code copy.

## Repository structure

Start as a monorepo in
[`johnsie/netpanzer-ng`](https://github.com/johnsie/netpanzer-ng). This keeps the
browser client, protocol-compatible native server, gateway, tests and deployment
configuration on one versioned commit. Split the service or infrastructure only
when independent release ownership makes that useful.

### `johnsie/netpanzer-ng`

Fork the upstream game repository with its full history.

- Start web work from upstream's `browser-production` branch, specifically around commit `dbbefb574d37a531a8da0710e9b25ec570175589`.
- Keep an `upstream` remote pointing at GitHub.
- Build both the browser client and native dedicated server from this repository.
- Maintain an `outiva-web` branch for Outiva UX and integration changes.
- Do not create a separate game-server fork initially. NetPanzer's executable already runs as a dedicated server with `-d`.

### Service code

Keep the initial Outiva-facing service under `support/web` in the same repository:

- Matchmaking endpoint
- WebSocket gateway
- Server registry
- Health and status collection
- Player-facing launch page
- Admin status page
- Rate limits and connection metrics
- Native local-development scripts and configuration

It can be split into a separate service later or folded into the existing Outiva
backend if appropriate.

### Deployment code

Keep the initial deployment configuration under `deploy/outiva`:

- Native systemd service definitions
- Reverse-proxy configuration
- Monitoring dashboards
- Environment-specific server configuration
- Infrastructure as code

Do not fork the old master server for the MVP. It is only necessary if Outiva intends to operate a public directory for third-party or native servers. An internal matchmaker registry is simpler and safer.

## Implementation roadmap

### Phase 0: Recover and reproduce the existing port

**Estimate:** 2-4 days

- Fork `browser-production`, not only the default branch.
- Pin the same Emscripten version used by the existing port.
- Build the browser client locally.
- Build a native dedicated server from the same commit.
- Run the gateway and browser tests.
- Verify that two browser clients can join the same match, spawn, move, resign, and reconnect.
- Keep the existing GitHub Actions build and browser-test workflow passing.

**Exit criterion:** A clean GitHub Actions pipeline produces a browser artifact and proves it can play against the native server in Chrome and Firefox.

This phase is important because the web port currently lives on a branch rather than being established default-branch architecture.

### Phase 1: Build the Outiva one-click launcher

**Estimate:** 4-7 days

Replace the current sequence:

> Play NetPanzer -> original menu -> Join -> server list -> choose server -> Play

with:

> Play -> automatically connect

The game already has a quick-connect path through the `--connect` option, so this is an adaptation rather than a networking rewrite.

The launcher should:

1. Fetch an Outiva match assignment.
2. Configure the WebSocket gateway for that server.
3. Start the Wasm application with `--master_server=none` and `--connect=<assigned-target>`.
4. Skip or replace the original main-menu and server-list flow in web builds.

Add an Outiva launch screen containing:

- Display name
- Play button
- Download progress
- A concise status such as "Finding a battlefield"
- Settings button
- Friendly retry states

Do not expose **Host** in the browser. Hosting requires a backend service and cannot run inside the browser.

### Phase 2: Add automatic matchmaking

**Estimate:** 5-8 days

Create an endpoint such as:

```http
POST /api/games/netpanzer/matches
```

It should return a short-lived, signed assignment:

```json
{
  "ticket": "signed-short-lived-token",
  "server": {
    "id": "eu-1",
    "name": "Outiva Europe"
  },
  "websocketUrl": "wss://play.outiva.com/netpanzer/game"
}
```

Only the gateway should know the real backend host and port.

Server eligibility rules:

- Online and recently health-checked
- Same NetPanzer protocol version as the web client
- Not full
- Not draining or restarting
- No password required for ordinary matchmaking
- Outiva-controlled or explicitly approved

Suggested scoring order:

1. Prefer the player's selected or nearest region.
2. Prefer a server with active players.
3. Avoid nearly full servers.
4. Keep reconnecting players on their previous server.
5. Use a stable random tie-breaker to prevent all clients piling onto one instance.

A simple initial model could be:

```text
eligible
+ same-region bonus
+ populated-server bonus
- gateway-to-server latency
- high-capacity penalty
+ previous-server stickiness
```

If no server is available, show a clear "Servers are starting - retrying" state. Automated server provisioning can come later.

### Phase 3: Deploy the first managed game server

**Estimate:** 3-5 days

Start with one game server and optionally two native bots so a new player does not enter an empty battlefield.

Deployment requirements:

- Native systemd service running `netpanzer -d`
- Persistent `server.cfg`
- Non-root runtime user
- Automatic restart
- Structured log collection
- TCP gameplay port available to the gateway
- UDP status port available to the health collector
- CPU and memory limits based on load testing
- Graceful draining state before deployment or restart
- Same game/protocol commit as the browser build

If only browser players will connect, the game port can remain private to the deployment network. Expose it publicly only if native desktop clients should join the same server.

### Phase 4: Persistent settings and friendly failures

**Estimate:** 5-8 days

The current browser port notes that browser settings reset on reload. This should be fixed before public launch.

Persist:

- Player/display name
- Sound and music volume
- Scroll speed
- Visual settings
- Preferred region
- Matchmaking mode
- Key settings where supported

Emscripten offers IDBFS for a persistent virtual filesystem. The [SDL Emscripten notes](https://wiki.libsdl.org/SDL2/README-emscripten) describe the distinction between in-memory MEMFS and browser-persistent IDBFS.

Translate technical failures into player language:

- Gateway unreachable: "The game service is temporarily unavailable."
- Server full: automatically request another server.
- Protocol mismatch: block the stale client and refresh its cached build.
- Server restart: "The battlefield restarted. Reconnecting..."
- Connection lost: retry once automatically, then show **Play again**.
- Asset failure: retry individual files without restarting the whole page.

### Phase 5: Loading and asset improvements

**Estimate:** 1-2 weeks for the first improvements; longer for full asset splitting

The current build preloads roughly 125 MB of uncompressed maps, graphics, sounds, and fonts. This is the largest product risk.

For the MVP:

- Serve Wasm and data files from a CDN.
- Use immutable, content-addressed URLs.
- Precompress with gzip or Brotli.
- Set the correct `application/wasm` MIME type.
- Show byte-based download progress.
- Begin downloading when the game page opens while the player enters their name.
- Cache assets aggressively.
- Keep at least the previous client revision available during deployments.

After launch, split assets into:

- Core UI, units, fonts, and common sounds
- Initial map pack
- Additional maps loaded on demand
- Optional music

Asset splitting is more invasive because NetPanzer currently expects a preloaded virtual filesystem. Measure the compressed download and abandonment rate before committing to that work.

Performance targets:

- Page shell visible in under 2 seconds
- Progress visible immediately
- Returning-player startup under 5 seconds when cached
- No complete redownload after an unrelated website deployment

### Phase 6: Production hardening

**Estimate:** 4-7 days

Carry over the strongest parts of the existing website deployment:

- Same-origin WebSockets
- Strict Origin validation
- Binary messages only
- Maximum message size
- Global and per-IP connection limits
- Connection-attempt rate limits
- Backpressure between WebSocket and TCP streams
- No arbitrary TCP destination supplied by the browser
- DNS-rebinding and private-address protection
- Exact release pin and checksum verification
- Atomic promotion and rollback

For Outiva, use an allowlist or signed matchmaking ticket rather than allowing the browser to make the gateway connect to any public hostname. This gives Outiva a smaller security boundary and keeps the experience curated.

Monitor:

- Concurrent browser connections
- Players per game server
- Matchmaking failures
- Gateway connection duration
- Disconnect reason
- Asset download time and failure rate
- Time from Play click to connected
- Game-server CPU, memory, and tick stability
- Client protocol mismatch rate

### Phase 7: Scale when justified

Possible later additions:

- Multiple regions
- Several game modes
- Automatic server creation and draining
- Party placement
- Private matches
- Spectator mode
- Scheduled events
- Outiva account identity and player statistics
- Moderation tools
- Native-client compatibility
- Mobile controls

Mobile should not be an MVP requirement. The current port is keyboard-and-mouse oriented, and making an RTS interface usable with touch controls is a separate project.

## MVP acceptance criteria

The project is ready for an initial Outiva launch when:

- A new player enters a display name and clicks **Play**.
- The player never sees an IP address or server list.
- The client automatically joins an available Outiva server.
- Settings survive reloads.
- Chrome, Firefox, and Edge are tested.
- Two browser players and native bots can share a game.
- A failed or full server produces an automatic retry or friendly error.
- Browser and server builds are protocol-compatible and released together.
- A previous web-client release can be restored without rebuilding.
- The server and gateway expose usable health and connection metrics.

A realistic solo-development estimate is **4-6 weeks for a polished MVP**, because the difficult engine-porting work already exists. Asset splitting, mobile support, and elastic server provisioning should be post-MVP work.

## Licensing and upstream considerations

NetPanzer is distributed under GPL v2-or-later. A modified browser binary must be accompanied by its corresponding source, licence notices, and build information. Every deployed client revision should link to the exact GitHub source revision used to build it.

The upstream repository's current README prohibits AI-assisted contributions to their project. Keep Outiva work in its own fork unless changes are coordinated directly with the upstream maintainers.

The code licence permits a fork, but code licensing and branding are separate matters. Confirm naming and logo expectations before presenting NetPanzer as an official Outiva title.

## Recommended first action

Prove the existing `browser-production` build first. Then implement one-click quick-connect and a ticket-based matchmaker.

Do not spend the first milestone rebuilding the renderer, protocol, master server, or dedicated server. Useful versions of all four already exist.
