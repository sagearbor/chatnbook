// Talks to the OAuth token endpoint (real Google/Microsoft in production,
// a local mock server in tests -- see providers.ts's *_OAUTH_TOKEN_URL
// overrides) to exchange an authorization code for tokens, and to refresh
// an access token using a stored refresh token.
import { getProviderConfig, type OAuthProviderName } from './providers.js';

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string; // ISO-8601
  scope?: string;
  tokenType?: string;
}

async function postForm(url: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`token endpoint returned non-JSON response (status ${res.status}): ${text}`);
  }
  if (!res.ok) {
    const detail = json?.error_description || json?.error || text;
    throw new Error(`token endpoint returned ${res.status}: ${detail}`);
  }
  return json;
}

function toTokenResponse(json: any, fallbackRefreshToken?: string): TokenResponse {
  if (!json.access_token) {
    throw new Error('token endpoint response is missing access_token');
  }
  const expiresIn = Number(json.expires_in ?? 3600);
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? fallbackRefreshToken,
    expiresAt,
    scope: json.scope,
    tokenType: json.token_type,
  };
}

export async function exchangeCodeForToken(
  provider: OAuthProviderName,
  code: string
): Promise<TokenResponse> {
  const cfg = getProviderConfig(provider);
  const json = await postForm(cfg.tokenUrl, {
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
  });
  return toTokenResponse(json);
}

export async function refreshAccessToken(
  provider: OAuthProviderName,
  refreshToken: string
): Promise<TokenResponse> {
  const cfg = getProviderConfig(provider);
  const json = await postForm(cfg.tokenUrl, {
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
  });
  return toTokenResponse(json, refreshToken);
}
