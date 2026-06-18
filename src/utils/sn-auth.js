import { createRequire } from 'module';
import { logger } from './logger.js';
import { httpFetch } from './http.js';

const require = createRequire(import.meta.url);

// OAuth token cache keyed by "<instanceUrl>::<clientId>" so concurrent sessions
// using different instances or different OAuth clients never share tokens.
// Basic auth produces no cached state (it's just a static base64 string).
const _tokenCache = new Map(); // key -> { token, expiry }

function _cacheKey(instanceUrl, clientId) {
  return `${instanceUrl}::${clientId}`;
}

function _getCached(key) {
  const entry = _tokenCache.get(key);
  if (!entry) return null;
  const now = Math.floor(Date.now() / 1000);
  return entry.expiry - now > 300 ? entry.token : null;
}

function _setCached(key, token, expiresIn) {
  _tokenCache.set(key, {
    token,
    expiry: Math.floor(Date.now() / 1000) + (expiresIn ?? 1800),
  });
}

// Read all SN config from process.env at call time (not module load time) so
// per-session credential overrides set via configure_credentials take effect.
function _snEnv() {
  return {
    instanceUrl:  process.env.SN_INSTANCE_URL,
    username:     process.env.SN_USERNAME,
    password:     process.env.SN_PASSWORD,
    useSdkAuth:   process.env.SN_USE_SDK_AUTH === 'true',
    oauthClientId:     process.env.SN_OAUTH_CLIENT_ID,
    oauthClientSecret: process.env.SN_OAUTH_CLIENT_SECRET,
  };
}

export async function getSnToken() {
  const now = Math.floor(Date.now() / 1000);
  const env = _snEnv();

  // ── OAuth 2.0 Client Credentials (production-friendly, machine-to-machine) ─
  if (env.oauthClientId && env.oauthClientSecret) {
    const key    = _cacheKey(env.instanceUrl, env.oauthClientId);
    const cached = _getCached(key);
    if (cached) return { instanceUrl: env.instanceUrl, token: cached, authType: 'bearer' };

    const url = `${env.instanceUrl}/oauth_token.do`;
    const res = await httpFetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     env.oauthClientId,
        client_secret: env.oauthClientSecret,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`SN OAuth client_credentials failed: ${JSON.stringify(json)}`);
    _setCached(key, json.access_token, json.expires_in);
    return { instanceUrl: env.instanceUrl, token: json.access_token, authType: 'bearer' };
  }

  // ── Basic auth (default — works for everyone, no caching needed) ──────────
  if (!env.useSdkAuth) {
    if (!env.username || !env.password) {
      throw new Error(
        'ServiceNow auth not configured.\n' +
        'Option A (recommended): Set SN_USERNAME and SN_PASSWORD in .env\n' +
        'Option B (now-sdk OAuth): Set SN_USE_SDK_AUTH=true and run: npx @servicenow/sdk auth --add <instance>'
      );
    }
    const token = Buffer.from(`${env.username}:${env.password}`).toString('base64');
    return { instanceUrl: env.instanceUrl, token, authType: 'basic' };
  }

  // ── OAuth via now-sdk Keychain (optional, for SDK users) ───────────────────
  let Entry, oAuthClient;
  try {
    ({ Entry } = require('@napi-rs/keyring'));
  } catch {
    throw new Error(
      'SN_USE_SDK_AUTH=true but @napi-rs/keyring is not installed.\n' +
      'Run: npm install @napi-rs/keyring\n' +
      'Or switch to basic auth: set SN_USERNAME and SN_PASSWORD in .env and SN_USE_SDK_AUTH=false'
    );
  }

  const raw = new Entry('ServiceNow', 'now-sdk').getPassword();
  if (!raw) {
    throw new Error(
      'No now-sdk credentials found in keychain.\n' +
      'Run: npx @servicenow/sdk auth --add <your-instance-url>\n' +
      'Or switch to basic auth: set SN_USERNAME and SN_PASSWORD in .env and SN_USE_SDK_AUTH=false'
    );
  }

  const store = JSON.parse(raw);
  const cred  = Object.values(store).find(c => c.isDefault) ?? Object.values(store)[0];
  if (!cred) throw new Error('No credentials found in now-sdk keychain store.');

  const { creds }      = cred;
  const instanceUrl    = env.instanceUrl ?? creds.instanceUrl;
  const sdkCacheKey    = _cacheKey(instanceUrl, 'now-sdk');

  if (creds.type !== 'oauth') {
    const token = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
    return { instanceUrl, token, authType: 'basic' };
  }

  const sdkCached = _getCached(sdkCacheKey);
  if (sdkCached) return { instanceUrl, token: sdkCached, authType: 'bearer' };

  if (creds.expires_at - now < 900) {
    logger.info('OAuth token expiring soon, refreshing...');
    try {
      ({ oAuthClient } = require('@servicenow/sdk-cli/dist/auth/OAuth/CodeGrant'));
      const client    = await oAuthClient(creds.instanceUrl);
      const refreshed = await client.refresh(creds.refresh_token);
      _setCached(sdkCacheKey, refreshed.access_token, (refreshed.expires_at ?? now + 3600) - now);
      return { instanceUrl, token: refreshed.access_token, authType: 'bearer' };
    } catch {
      throw new Error(
        'OAuth token refresh failed. Re-authenticate with:\n' +
        '  npx @servicenow/sdk auth --add <instance>'
      );
    }
  }

  _setCached(sdkCacheKey, creds.access_token, creds.expires_at - now);
  return { instanceUrl, token: creds.access_token, authType: 'bearer' };
}

export function buildSnHeaders(token, authType = 'bearer') {
  return {
    Authorization: authType === 'basic' ? `Basic ${token}` : `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept:         'application/json',
  };
}
