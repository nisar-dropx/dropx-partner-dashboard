/**
 * Cloak authenticates API calls with Amplify-style Cognito cookies:
 *   CognitoIdentityServiceProvider.<clientId>.<username>.{accessToken,idToken,refreshToken}
 *   CognitoIdentityServiceProvider.<clientId>.LastAuthUser
 *   csrf_token
 * These helpers read / rewrite that cookie header without touching anything else.
 */

export function parseCookieHeader(cookie: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (name) out.set(name, part.slice(idx + 1).trim());
  }
  return out;
}

export function serializeCookieHeader(map: Map<string, string>): string {
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

export interface CloakTokens {
  prefix: string; // CognitoIdentityServiceProvider.<clientId>.<username>
  username: string;
  accessToken: string | null;
  idToken: string | null;
  refreshToken: string | null;
}

export function readCloakTokens(cookie: string, clientId: string): CloakTokens | null {
  const map = parseCookieHeader(cookie);
  const base = `CognitoIdentityServiceProvider.${clientId}.`;
  let username = map.get(`${base}LastAuthUser`) ?? '';
  if (!username) {
    for (const name of map.keys()) {
      if (name.startsWith(base) && name.endsWith('.accessToken')) {
        username = name.slice(base.length, -'.accessToken'.length);
        break;
      }
    }
  }
  if (!username) return null;
  const prefix = `${base}${username}`;
  return {
    prefix,
    username,
    accessToken: map.get(`${prefix}.accessToken`) ?? null,
    idToken: map.get(`${prefix}.idToken`) ?? null,
    refreshToken: map.get(`${prefix}.refreshToken`) ?? null,
  };
}

export function withRefreshedTokens(
  cookie: string,
  tokens: CloakTokens,
  next: { accessToken: string; idToken?: string | null; refreshToken?: string | null },
): string {
  const map = parseCookieHeader(cookie);
  map.set(`${tokens.prefix}.accessToken`, next.accessToken);
  if (next.idToken) map.set(`${tokens.prefix}.idToken`, next.idToken);
  if (next.refreshToken) map.set(`${tokens.prefix}.refreshToken`, next.refreshToken);
  return serializeCookieHeader(map);
}

/** JWT `exp` in ms, or 0 when unreadable. No signature check — server decides validity. */
export function jwtExpiryMs(token: string | null): number {
  if (!token) return 0;
  const payload = token.split('.')[1];
  if (!payload) return 0;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function isCloakCookieComplete(cookie: string, clientId: string): boolean {
  const tokens = readCloakTokens(cookie, clientId);
  return Boolean(tokens?.accessToken && tokens.idToken);
}

/**
 * Text Cloak shows when its client cache is stale/corrupt. Matched loosely on
 * purpose: any page or API body mentioning a cache failure triggers a full
 * clear-and-relogin rather than retrying with the same state.
 */
export const CACHE_ERROR_RE =
  /(cache[ds]?|cached data)[^.]{0,80}(error|fail|stale|corrupt|invalid|clear)|(clear|error)[^.]{0,80}(cache|cached data)/i;
