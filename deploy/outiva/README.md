# Outiva deployment

Production hostname: `netpanzer.outiva.com`

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
/srv/netpanzer/current/client/        browser release files
/etc/netpanzer/servers.json           gateway server allowlist
/var/lib/netpanzer/.netpanzer/config/server.cfg
/etc/ssl/netpanzer.outiva.com/origin.crt
/etc/ssl/netpanzer.outiva.com/origin.key
```

The browser release directory must contain `index.html`, `launcher.js`,
`netpanzer.js`, `netpanzer.wasm`, and `netpanzer.data`.

## Apache modules

On Debian or Ubuntu:

```sh
sudo a2enmod ssl proxy proxy_http proxy_wstunnel headers mime
```

Install the vhost, enable it, and validate Apache before reloading:

```sh
sudo apachectl configtest
sudo systemctl reload apache2
```

The origin certificate may be self-signed if HAProxy is configured to trust
its CA or to skip verification for this private backend. Using a private CA is
preferable where one is available.

## Service order

1. Build and install the native server and browser release from the same commit.
2. Install the server configuration and `servers.json`.
3. Start `netpanzer-game.service` and confirm TCP/UDP status on port 3030.
4. Start `netpanzer-web.service` and check `http://127.0.0.1:8080/servers`.
5. Enable the Apache vhost.
6. Test `https://netpanzer.outiva.com/` and an actual game connection through HAProxy.

The services bind to loopback by default. Keep firewall rules in place so the
origin remains reachable only through the intended HAProxy path.
