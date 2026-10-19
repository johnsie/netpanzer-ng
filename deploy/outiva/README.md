# Outiva deployment

Production hostname: `netpanzer.outiva.com`

Outiva deployment is deliberately Docker-free. The game and gateway run as
native systemd services, with Apache as the origin web server.

HAProxy terminates the public TLS connection and forwards HTTPS to Apache at
`192.168.10.181`. Apache uses an internal origin certificate, then proxies to
the NetPanzer web/gateway service on `127.0.0.1:8080`.

HAProxy must replace `X-Forwarded-For` with the connecting player's address
before sending the request to Apache. The gateway's `--trust-proxy` mode only
uses that header when its immediate peer is loopback Apache; direct remote
connections cannot supply their own client identity.

```text
Player -> HTTPS -> HAProxy -> HTTPS -> Apache -> HTTP/WS 127.0.0.1:8080
                                                   |
                                                   +-> TCP 127.0.0.1:3030
                                                       NetPanzer server
```

Neither port 8080 nor port 3030 needs to be exposed to the LAN when browser
players are the only clients. Open TCP and UDP 3030 externally only if native
NetPanzer clients should be able to join the Outiva server directly.

## Files

- `apache/netpanzer.outiva.com.conf`: Apache HTTPS origin vhost.
- `systemd/netpanzer-web.service`: browser assets, status API, and WebSocket gateway.
- `systemd/netpanzer-game.service`: native dedicated server.
- `config/servers.json`: allowlisted matchmaking targets.
- `config/server.cfg`: initial game-server configuration.

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

The origin certificate may be self-signed if HAProxy is configured to trust
its CA or to skip verification for this private backend. Using a private CA is
preferable where one is available.

For the stated private HAProxy-to-origin setup, this helper creates a
self-signed certificate with both the hostname and `192.168.10.181` in its
subject alternative names. It refuses to overwrite an existing certificate:

```sh
sudo deploy/outiva/create-origin-certificate.sh
```

## Service order

1. Build and install the native server and browser release from the same commit.
2. Put the origin certificate and key at the paths above.
3. Start `netpanzer-game.service` and confirm TCP/UDP status on port 3030.
4. Start `netpanzer-web.service` and check `http://127.0.0.1:8080/servers`.
5. Enable and validate the Apache vhost.
6. Test `https://netpanzer.outiva.com/` and an actual game connection through HAProxy.

```sh
sudo systemctl enable --now netpanzer-game.service
sudo systemctl enable --now netpanzer-web.service
curl --fail http://127.0.0.1:8080/servers
sudo a2enmod ssl proxy proxy_http proxy_wstunnel headers mime
sudo a2ensite netpanzer.outiva.com
sudo apachectl configtest
sudo systemctl reload apache2
```

The services bind to loopback by default. Keep firewall rules in place so the
origin remains reachable only through the intended HAProxy path.
