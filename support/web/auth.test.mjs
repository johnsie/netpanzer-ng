import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createOptionalOidc } from './auth.mjs';

const issuer = 'https://accounts.example/realms/outiva';
const clientId = 'netpanzer-web';
const jwt = claims => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

test('OIDC callback creates a signed NetPanzer session while guests remain anonymous', async t => {
  let nonce;
  const oidc = createOptionalOidc({
    issuer, clientId, clientSecret: 'client-secret', sessionSecret: 's'.repeat(48),
    origin: 'https://netpanzer.example', parentOrigin: 'https://outiva.example', now: () => 1_000_000,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/token')) return new Response(JSON.stringify({
        access_token: 'access',
        id_token: jwt({ iss: issuer, aud: clientId, nonce, exp: 2000, sub: 'user-123' }),
      }), { status: 200 });
      assert.equal(options.headers.Authorization, 'Bearer access');
      return new Response(JSON.stringify({ sub: 'user-123', name: 'Test Commander', email: 'test@example.com' }), { status: 200 });
    },
  });
  const server = http.createServer(async (req, res) => oidc.handle(req, res, new URL(req.url, 'https://netpanzer.example')));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/auth/me`)).status, 204);
  const login = await fetch(`${base}/auth/login?prompt=none`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const authorization = new URL(login.headers.get('location'));
  nonce = authorization.searchParams.get('nonce');
  assert.equal(authorization.searchParams.get('prompt'), 'none');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');

  const callback = await fetch(`${base}/auth/callback?code=code&state=${authorization.searchParams.get('state')}`);
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /outiva:netpanzer-auth/);
  const cookie = callback.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^__Host-netpanzer_session=/);

  const me = await fetch(`${base}/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), {
    sub: 'user-123', name: 'Test Commander', preferred_username: '', email: 'test@example.com',
  });
  assert.equal((await fetch(`${base}/auth/me`, { headers: { Cookie: `${cookie}tampered` } })).status, 204);
});
