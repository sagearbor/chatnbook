// OAuth 2.0 authorization-code flow configuration for Google Calendar and
// Microsoft Graph (calendar) access. Client id/secret/redirect URI come
// from the env var names already documented in .env.example -- this file
// does not rename or replace any of those. The provider endpoint URLs
// (auth/token) default to the real Google/Microsoft endpoints but can be
// overridden via *_OAUTH_AUTH_URL / *_OAUTH_TOKEN_URL, which is how tests
// point this at a local mock OAuth provider instead of the real thing.

export type OAuthProviderName = 'google' | 'microsoft';

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  scope: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export function isOAuthProvider(value: string): value is OAuthProviderName {
  return value === 'google' || value === 'microsoft';
}

export function getProviderConfig(provider: OAuthProviderName): OAuthProviderConfig {
  if (provider === 'google') {
    return {
      clientId: requireEnv('GOOGLE_CLIENT_ID'),
      clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
      redirectUri: requireEnv('GOOGLE_REDIRECT_URI'),
      authUrl: process.env.GOOGLE_OAUTH_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: process.env.GOOGLE_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token',
      scope: process.env.GOOGLE_OAUTH_SCOPE || 'https://www.googleapis.com/auth/calendar',
    };
  }
  const tenant = process.env.MS_TENANT || 'common';
  return {
    clientId: requireEnv('MS_CLIENT_ID'),
    clientSecret: requireEnv('MS_CLIENT_SECRET'),
    redirectUri: requireEnv('MS_REDIRECT_URI'),
    authUrl:
      process.env.MS_OAUTH_AUTH_URL ||
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl:
      process.env.MS_OAUTH_TOKEN_URL ||
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scope: process.env.MS_OAUTH_SCOPE || 'offline_access Calendars.ReadWrite',
  };
}
