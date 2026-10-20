import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = '__Host-netpanzer_session';
const SESSION_SECONDS = 8 * 60 * 60;
const STATE_TTL_MS = 5 * 60 * 1000;

const base64url = value => Buffer.from(value).toString('base64url');
const randomValue = (bytes = 32) => randomBytes(bytes).toString('base64url');

function cookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const at = part.indexOf('=');
    if (at < 0) return ['', ''];
    return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
  }).filter(([name]) => name));
}

function jwtClaims(token) {
  const part = token?.split('.')[1];
  if (!part) throw new Error('The identity provider returned an invalid ID token.');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function safeProfile(profile) {
  const text = key => typeof profile[key] === 'string' ? profile[key].slice(0, 254) : '';
  return {
    sub: text('sub'),
    name: text('name'),
    preferred_username: text('preferred_username'),
    email: text('email'),
  };
}

function send(res, status, headers = {}, body = '') {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function popupResult(res, parentOrigin, ok) {
  const message = JSON.stringify({ type: 'outiva:netpanzer-auth', ok });
  const target = JSON.stringify(parentOrigin);
  send(res, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
  }, `<!doctype html><meta charset="utf-8"><title>NetPanzer sign-in</title>
<style>html{color-scheme:dark;background:#0f1115;color:#eceef3;font:16px system-ui}body{display:grid;min-height:90vh;place-items:center}</style>
<p>${ok ? 'Connected to NetPanzer.' : 'Continuing as a guest.'}</p>
<script>window.opener?.postMessage(${message},${target});window.close();</script>`);
}

export function createOptionalOidc({ issuer, clientId, clientSecret, sessionSecret,
  origin, parentOrigin = 'https://outiva.com', backchannelUrl = issuer,
  fetchImpl = fetch, now = () => Date.now() }) {
  const configured = [issuer, clientId, clientSecret, sessionSecret].filter(Boolean).length;
  if (configured === 0) return {
    enabled: false,
    profile: () => null,
    handle: async () => false,
  };
  if (configured !== 4) throw new Error('OIDC needs issuer, client ID, client secret, and session secret.');
  if (Buffer.byteLength(sessionSecret) < 32) throw new Error('NETPANZER_SESSION_SECRET must be at least 32 bytes.');

  issuer = issuer.replace(/\/$/, '');
  backchannelUrl = backchannelUrl.replace(/\/$/, '');
  origin = new URL(origin).origin;
  parentOrigin = new URL(parentOrigin).origin;
  const redirectUri = `${origin}/auth/callback`;
  const pending = new Map();

  function sign(payload) {
    return createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  }

  function sessionCookie(profile) {
    const payload = base64url(JSON.stringify({ profile: safeProfile(profile), exp: now() + SESSION_SECONDS * 1000 }));
    return `${SESSION_COOKIE}=${payload}.${sign(payload)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
  }

  function profile(req) {
    const token = cookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const at = token.lastIndexOf('.');
    if (at < 1) return null;
    const payload = token.slice(0, at);
    const supplied = Buffer.from(token.slice(at + 1));
    const expected = Buffer.from(sign(payload));
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return session.exp > now() && session.profile?.sub ? safeProfile(session.profile) : null;
    } catch { return null; }
  }

  async function handle(req, res, url) {
    if (url.pathname === '/auth/me' && req.method === 'GET') {
      const current = profile(req);
      if (!current) send(res, 204);
      else send(res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(current));
      return true;
    }

    if (url.pathname === '/auth/login' && req.method === 'GET') {
      for (const [key, request] of pending) if (now() - request.created > STATE_TTL_MS) pending.delete(key);
      if (pending.size >= 1000) pending.delete(pending.keys().next().value);
      const state = randomValue();
      const nonce = randomValue();
      const verifier = randomValue(64);
      pending.set(state, { nonce, verifier, created: now() });
      const authorization = new URL(`${issuer}/protocol/openid-connect/auth`);
      authorization.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        response_mode: 'query',
        scope: 'openid profile email',
        state,
        nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        ...(url.searchParams.get('prompt') === 'none' ? { prompt: 'none' } : {}),
      });
      send(res, 302, { Location: authorization.href });
      return true;
    }

    if (url.pathname === '/auth/callback' && req.method === 'GET') {
      const state = url.searchParams.get('state');
      const request = state && pending.get(state);
      if (state) pending.delete(state);
      if (!request || now() - request.created > STATE_TTL_MS || url.searchParams.has('error')) {
        popupResult(res, parentOrigin, false);
        return true;
      }
      try {
        const tokenResponse = await fetchImpl(`${backchannelUrl}/protocol/openid-connect/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code: url.searchParams.get('code') || '',
            code_verifier: request.verifier,
          }),
        });
        if (!tokenResponse.ok) throw new Error('Token exchange failed.');
        const tokens = await tokenResponse.json();
        const claims = jwtClaims(tokens.id_token);
        const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (claims.iss !== issuer || !audiences.includes(clientId) || claims.nonce !== request.nonce ||
            claims.exp * 1000 <= now() || !claims.sub) throw new Error('Invalid identity claims.');
        const userResponse = await fetchImpl(`${backchannelUrl}/protocol/openid-connect/userinfo`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (!userResponse.ok) throw new Error('User profile request failed.');
        const user = safeProfile(await userResponse.json());
        if (!user.sub || user.sub !== claims.sub) throw new Error('User profile did not match the ID token.');
        res.setHeader('Set-Cookie', sessionCookie(user));
        popupResult(res, parentOrigin, true);
      } catch (error) {
        console.error(`OIDC callback failed: ${error.message}`);
        popupResult(res, parentOrigin, false);
      }
      return true;
    }
    return false;
  }

  return { enabled: true, profile, handle };
}
