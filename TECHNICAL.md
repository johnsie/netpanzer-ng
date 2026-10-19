# NetPanzer technical details

This document is the starting point for developers and server operators. The
main [README](README.md) is intentionally written for players.

## Project layout

This repository contains the original NetPanzer game, the browser client, the
multiplayer gateway, automated tests and the Outiva deployment configuration.
The browser and native game server are built from the same source so they remain
compatible.

Important areas include:

- `src/` — game and dedicated-server source code.
- `data/` — maps, units, artwork, sounds and other game content.
- `support/web/` — browser launcher, gateway and browser test suite.
- `deploy/outiva/` — Apache, systemd and release-management configuration.
- `tests/` — native automated tests.

## Browser client

The game is compiled for the browser and connects through a gateway to a native
NetPanzer server. The launcher automatically selects a healthy approved server;
players do not need to choose an address or port.

Build instructions, local development options, gateway behaviour and browser
tests are documented in the [browser client guide](support/web/README.md).

## Native builds

Desktop and dedicated-server dependencies, build options and installation steps
are in [BUILD.md](BUILD.md). Dedicated server configuration is covered by the
[server guide](docs/SERVER-HOWTO.md).

## Outiva deployment

The production deployment does not use Docker. NetPanzer runs as native systemd
services behind Apache, with HAProxy handling the public HTTPS connection.
Releases are checksummed, activated atomically and can return to the previous
browser release if activation fails.

See the [Outiva deployment guide](deploy/outiva/README.md) for the server layout,
installation, release and proxy configuration.

## Testing

The web test suite covers the gateway, matchmaking, browser loading, joining a
real game, rendering, fullscreen behaviour and game input. Native test details
are available in the [test guide](tests/README.md).

## Planning and contributions

- [Outiva implementation roadmap](ROADMAP.md)
- [Contribution guide](CONTRIBUTING.md)
- [Project changes](CHANGELOG.md)

Before submitting a change, read the contribution guide and run the tests that
cover the affected part of the project.
