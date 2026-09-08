// Express router implementing the OAuth 2.0 authorization-code flow for
// Google Calendar / Microsoft Graph:
//   GET /oauth/:provider/start?accountId=...    -> 302 redirect to provider
//   GET /oauth/:provider/callback?code&state    -> exchanges code, stores
//                                                   encrypted tokens
// State is a signed (HMAC), self-contained token embedding accountId +
// provider + a nonce + timestamp -- no server-side session/state storage
// is needed, so this works the same whether the API has 1 instance or N.
import express from 'express';
import crypto from 'crypto';
import { getProviderConfig, isOAuthProvider, type OAuthProviderName } from './providers.js';
import { exchangeCodeForToken, refreshAccessToken } from './oauth-client.js';
import { encrypt, decrypt } from './crypto.js';
import type { OAuthTokensRepository } from '../repositories/oauth-tokens-repo.js';

/** Thrown by getValidAccessToken when no token is on file, or it's expired
 * with no refresh token to recover with -- distinct from network/transport
 * errors so callers can map it to a 400 instead of a 5xx. */
export class CalendarNotConnectedError extends Error {}

const STATE_MAX_AGE_MS = 10 * 60_000; // 10 minutes
const STATE_CLOCK_SKEW_MS = 60_000;
const REFRESH_SKEW_MS = 60_000; // refresh a token if it expires within 1 minute

function stateSecret(): string {
  const secret = process.env.AGENT_HMAC_SECRET;
  if (!secret) {
    throw new Error('AGENT_HMAC_SECRET is not set (also used to sign the OAuth state parameter)');
  }
  return secret;
}

export function signState(accountId: string, provider: OAuthProviderName): string {
  const nonce = crypto.randomBytes(8).toString('hex');
  const ts = Date.now().toString();
  const payload = `${accountId}|${provider}|${nonce}|${ts}`;
  const sig = crypto.createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  return Buffer.from(`${payload}|${sig}`, 'utf8').toString('base64url');
}

export function verifyState(state: string, provider: OAuthProviderName): { accountId: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(state, 'base64url').toString('utf8');
  } catch {
    throw new Error('malformed state');
  }
  const parts = decoded.split('|');
  if (parts.length !== 5) {
    throw new Error('malformed state');
  }
  const [accountId, stateProvider, , ts, sig] = parts;
  if (stateProvider !== provider) {
    throw new Error('provider mismatch in state');
  }
  const payload = parts.slice(0, 4).join('|');
  const expected = crypto.createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('invalid state signature');
  }
  const age = Date.now() - Number(ts);
  if (!Number.isFinite(age) || age > STATE_MAX_AGE_MS || age < -STATE_CLOCK_SKEW_MS) {
    throw new Error('state expired');
  }
  if (!accountId) {
    throw new Error('missing accountId in state');
  }
  return { accountId };
}

export function createOAuthRouter(tokensRepo: OAuthTokensRepository) {
  const router = express.Router();

  router.get('/oauth/:provider/start', (req, res) => {
    const provider = req.params.provider;
    if (!isOAuthProvider(provider)) {
      return res.status(404).json({ error: `unsupported provider: ${provider}` });
    }
    const accountId = String(req.query.accountId || '');
    if (!accountId) {
      return res.status(400).json({ error: 'accountId query parameter is required' });
    }
    let cfg;
    try {
      cfg = getProviderConfig(provider);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
    const state = signState(accountId, provider);
    const url = new URL(cfg.authUrl);
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('redirect_uri', cfg.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', cfg.scope);
    url.searchParams.set('state', state);
    if (provider === 'google') {
      // Needed to receive a refresh_token from Google.
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
    }
    res.redirect(302, url.toString());
  });

  router.get('/oauth/:provider/callback', async (req, res) => {
    const provider = req.params.provider;
    if (!isOAuthProvider(provider)) {
      return res.status(404).json({ error: `unsupported provider: ${provider}` });
    }
    const oauthError = req.query.error;
    if (oauthError) {
      return res.status(400).json({ error: `oauth provider error: ${oauthError}` });
    }
    const code = req.query.code;
    const state = req.query.state;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'code query parameter is required' });
    }
    if (!state || typeof state !== 'string') {
      return res.status(400).json({ error: 'state query parameter is required' });
    }
    let accountId: string;
    try {
      ({ accountId } = verifyState(state, provider));
    } catch (err) {
      return res.status(400).json({ error: `invalid state: ${(err as Error).message}` });
    }
    try {
      const token = await exchangeCodeForToken(provider, code);
      const record = await tokensRepo.upsert({
        accountId,
        provider,
        accessTokenEncrypted: encrypt(token.accessToken),
        refreshTokenEncrypted: token.refreshToken ? encrypt(token.refreshToken) : null,
        expiresAt: token.expiresAt,
        scope: token.scope ?? null,
      });
      res.json({
        accountId: record.accountId,
        provider: record.provider,
        connected: true,
        expiresAt: record.expiresAt,
      });
    } catch (err) {
      console.error('oauth token exchange failed', err);
      res.status(502).json({ error: 'failed to exchange authorization code for tokens' });
    }
  });

  return router;
}

/**
 * Returns a valid (non-expired) access token for accountId/provider,
 * transparently refreshing it first if it's expired or about to expire.
 * Throws if no token is on file (calendar not connected) or refresh fails.
 */
export async function getValidAccessToken(
  tokensRepo: OAuthTokensRepository,
  accountId: string,
  provider: OAuthProviderName
): Promise<string> {
  const record = await tokensRepo.getByAccountAndProvider(accountId, provider);
  if (!record) {
    throw new CalendarNotConnectedError(`no ${provider} calendar connected for account ${accountId}`);
  }
  const expiresAt = new Date(record.expiresAt).getTime();
  if (expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return decrypt(record.accessTokenEncrypted);
  }
  if (!record.refreshTokenEncrypted) {
    throw new CalendarNotConnectedError(
      `${provider} access token for account ${accountId} has expired and no refresh token is stored; reconnect via /oauth/${provider}/start`
    );
  }
  const refreshToken = decrypt(record.refreshTokenEncrypted);
  const refreshed = await refreshAccessToken(provider, refreshToken);
  const updated = await tokensRepo.upsert({
    accountId,
    provider,
    accessTokenEncrypted: encrypt(refreshed.accessToken),
    refreshTokenEncrypted: encrypt(refreshed.refreshToken ?? refreshToken),
    expiresAt: refreshed.expiresAt,
    scope: refreshed.scope ?? record.scope,
  });
  return decrypt(updated.accessTokenEncrypted);
}
