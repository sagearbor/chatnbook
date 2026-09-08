// A tiny local stand-in for a real OAuth 2.0 provider's authorize/token
// endpoints (works for both Google's and Microsoft's flow shapes, which
// are both plain OAuth 2.0 authorization-code). Tests point
// GOOGLE_OAUTH_AUTH_URL/GOOGLE_OAUTH_TOKEN_URL (or the MS_* equivalents)
// at this server instead of the real provider -- no real client
// id/secret/consent screen needed.
//
// Behavior:
//  - GET  /authorize -> issues an opaque one-time "code" and redirects to
//    the caller-supplied redirect_uri?code=...&state=...
//  - POST /token, grant_type=authorization_code -> exchanges a valid code
//    (once) for an access_token + refresh_token
//  - POST /token, grant_type=refresh_token -> issues a new access_token
//    for a valid refresh_token
//
// Also exposes `issuedAccessTokens`/`issuedRefreshTokens` (Sets) so tests
// can assert real, provider-shaped tokens were minted -- not fixtures.
import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';

export function startMockOAuthProvider() {
  const codes = new Map(); // code -> { used, clientId }
  const refreshTokens = new Set();
  const accessTokens = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      const code = crypto.randomBytes(12).toString('hex');
      codes.set(code, { used: false });
      const dest = new URL(redirectUri);
      dest.searchParams.set('code', code);
      if (state) dest.searchParams.set('state', state);
      res.writeHead(302, { Location: dest.toString() });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const grantType = params.get('grant_type');
        res.setHeader('Content-Type', 'application/json');

        if (grantType === 'authorization_code') {
          const code = params.get('code');
          const entry = codes.get(code);
          if (!entry || entry.used) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'unknown or reused code' }));
            return;
          }
          entry.used = true;
          const accessToken = `mock_access_${crypto.randomBytes(8).toString('hex')}`;
          const refreshToken = `mock_refresh_${crypto.randomBytes(8).toString('hex')}`;
          accessTokens.add(accessToken);
          refreshTokens.add(refreshToken);
          res.writeHead(200);
          res.end(
            JSON.stringify({
              access_token: accessToken,
              refresh_token: refreshToken,
              expires_in: 3600,
              token_type: 'Bearer',
              scope: 'mock.scope',
            })
          );
          return;
        }

        if (grantType === 'refresh_token') {
          const refreshToken = params.get('refresh_token');
          if (!refreshTokens.has(refreshToken)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'unknown refresh_token' }));
            return;
          }
          const accessToken = `mock_access_${crypto.randomBytes(8).toString('hex')}`;
          accessTokens.add(accessToken);
          res.writeHead(200);
          res.end(
            JSON.stringify({
              access_token: accessToken,
              expires_in: 3600,
              token_type: 'Bearer',
              scope: 'mock.scope',
            })
          );
          return;
        }

        res.writeHead(400);
        res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const base = `http://127.0.0.1:${port}`;
      resolve({
        base,
        authUrl: `${base}/authorize`,
        tokenUrl: `${base}/token`,
        issuedAccessTokens: accessTokens,
        issuedRefreshTokens: refreshTokens,
        async close() {
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}
