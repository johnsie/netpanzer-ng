# Outiva deployment

Production hostname: `netpanzer.outiva.com`

Outiva deployment is deliberately Docker-free. The game and gateway run as
native systemd services, with Apache as the origin web server. A reverse proxy
handles public TLS and forwards HTTPS traffic to Apache. Environment-specific
addresses and network layout are intentionally not documented here.

The reverse proxy must replace `X-Forwarded-For` with the connecting player's
address before sending the request to Apache. The gateway's `--trust-proxy`
mode only uses that header when its immediate peer is loopback Apache; direct
remote connections cannot supply their own client identity.

```text
Player -> HTTPS -> Reverse proxy -> HTTPS -> Apache -> NetPanzer gateway
                                                        |
                                                        +-> NetPanzer server
```

The gateway and game-server ports should not be exposed publicly when browser
players are the only clients. Expose the native game port only if native
NetPanzer clients should be able to join the Outiva server directly.

## Files

- `apache/netpanzer.outiva.com.conf`: Apache HTTPS origin vhost.
- `systemd/netpanzer-web.service`: browser assets, status API, and WebSocket gateway.
- `systemd/netpanzer-game.service`: native dedicated server.
- `config/servers.json`: allowlisted matchmaking targets.
- `config/server.cfg`: initial game-server configuration.
- `keycloak/netpanzer-client.json`: confidential OIDC client definition.
- `configure-oidc.sh`: installs that client and the protected service secrets.

## Expected installation paths

```text
/opt/netpanzer-ng/                    repository checkout
/opt/netpanzer-ng/build-native/       native build
/srv/netpanzer/current/               browser release files
/etc/netpanzer/servers.json           gateway server allowlist
/var/lib/netpanzer/.netpanzer/config/server.cfg
/etc/ssl/netpanzer.outiva.com/origin.crt
/etc/ssl/netpanzer.outiva.com/origin.key
```

The browser release directory must contain `index.html`, `launcher.js`,
`netpanzer.js`, `netpanzer.wasm`, and `netpanzer.data`.

## Native build and installation

Use a checkout at `/opt/netpanzer-ng`. Install the Debian/Ubuntu build tools,
Node.js 22, and activate the pinned Emscripten SDK described in
`support/web/README.md`. Then build both native and browser artifacts as the
normal deployment user:

```sh
cd /opt/netpanzer-ng
deploy/outiva/build-native-release.sh
```

The build script refuses to package tracked local changes, builds the native
server, installs the locked production Node dependency, builds WebAssembly,
and creates a checksummed archive in `dist-web/`. It does not require or use
Docker.

Install the result as root, supplying the generated archive:

```sh
sudo deploy/outiva/install-host.sh \
  dist-web/netpanzer-web-<full-commit-sha>.tar.gz
```

The installer verifies the SHA-256 sidecar, validates the archive layout,
creates the unprivileged `netpanzer` account, installs an immutable browser
release, switches `/srv/netpanzer/current` atomically, and installs the service
and Apache definitions. Existing `server.cfg` and `servers.json` files are
preserved. It deliberately does not start services or enable the Apache site,
so a missing certificate cannot disrupt the existing web server.

After the one-time host installation, routine releases do not need full root
access. Give the deployment account group write access to `/srv/netpanzer`,
and allow only this exact service restart through sudo:

```sudoers
netpanzer-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart netpanzer-game.service netpanzer-web.service
```

Future releases can then be built and activated with:

```sh
source /opt/emsdk/emsdk_env.sh
cd /opt/netpanzer-ng
git pull --ff-only origin main
deploy/outiva/build-native-release.sh
deploy/outiva/activate-release.sh \
  dist-web/netpanzer-web-$(git rev-parse HEAD).tar.gz
```

The activator validates the archive and manifest, switches the browser release
atomically, and restarts only the two unprivileged NetPanzer services. If the
restart fails, it restores the previous browser release.

## Apache modules

On Debian or Ubuntu:

```sh
sudo a2enmod ssl proxy proxy_http proxy_wstunnel headers mime
```

Install the vhost, enable it, and validate Apache before reloading:

```sh
sudo a2ensite netpanzer.outiva.com
sudo apachectl configtest
sudo systemctl reload apache2
```

The origin certificate may be self-signed if the reverse proxy is configured
to trust its CA or to skip verification for the backend. Using a private CA is
preferable where one is available. This helper creates the origin certificate
and refuses to overwrite an existing certificate:

```sh
sudo deploy/outiva/create-origin-certificate.sh
```

## Service order

1. Build and install the native server and browser release from the same commit.
2. Put the origin certificate and key at the paths above.
3. Start `netpanzer-game.service` and confirm TCP/UDP status on port 3030.
4. Start `netpanzer-web.service` and check `http://127.0.0.1:8080/servers`.
5. Enable and validate the Apache vhost.
6. Test `https://netpanzer.outiva.com/` and an actual game connection through the reverse proxy.

```sh
sudo systemctl enable --now netpanzer-game.service
sudo systemctl enable --now netpanzer-web.service
curl --fail http://127.0.0.1:8080/servers
sudo a2enmod ssl proxy proxy_http proxy_wstunnel headers mime
sudo a2ensite netpanzer.outiva.com
sudo apachectl configtest
sudo systemctl reload apache2
```

The services bind to loopback by default. Keep firewall rules in place so they
remain reachable only through the intended reverse-proxy path.

## Optional Outiva account hand-off

NetPanzer remains anonymous by default. A visitor who opens
`netpanzer.outiva.com` directly is not redirected to Accounts and can choose a
callsign and play as a guest. When a user already signed in at `outiva.com`
clicks Play, Outiva makes a brief top-level round trip through NetPanzer's
authorization endpoint with `prompt=none`. Keycloak reuses its existing SSO
session, NetPanzer creates its own signed, HttpOnly session cookie, and the
browser returns to the embedded game. A second silent round trip restores
Outiva's memory-only session after the page navigation. This flow uses no
popup and sends no access token through a URL or the game iframe.

For signed-in players, the most recently used valid callsign is stored against
the immutable Keycloak `sub` in `/var/lib/netpanzer/callsigns.json` and restored
on later visits, including from another browser. Guest callsigns remain local
to that browser. The systemd sandbox permits the gateway to write only within
`/var/lib/netpanzer`; the callsign file is created mode `0600`.

After installing the updated systemd service, configure Keycloak and generate
the NetPanzer secrets with:

```sh
cd /opt/netpanzer-ng
sudo deploy/outiva/configure-oidc.sh
```

The script creates or updates a confidential client with these values:

- Realm: `outiva`
- Client ID: `netpanzer-web`
- Client authentication: On (confidential client)
- Standard flow: On; implicit, direct-access grants, and service accounts: Off
- Valid redirect URI: `https://netpanzer.outiva.com/auth/callback`
- Web origin: `https://netpanzer.outiva.com`
- PKCE method: `S256`

It obtains the generated client secret from Keycloak and stores it, together
with a separate random session-signing secret, in `/etc/netpanzer/oidc.env` as
root-owned mode `0640`. These values belong in that protected service file,
not in source control or browser JavaScript. The issuer is
`https://accounts.outiva.com/realms/outiva`. The server-side token and userinfo
requests use Keycloak's loopback endpoint, so they do not depend on public DNS;
tokens are still validated against the public issuer.
