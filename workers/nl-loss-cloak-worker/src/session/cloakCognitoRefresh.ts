import type { Env } from '../types';
import { cloakCognitoClientId, cloakCognitoRegion } from '../config';
import { readCloakTokens, withRefreshedTokens } from './cloakCookies';

/**
 * Renew Cloak's Cognito access/id tokens from the stored refresh token —
 * no browser needed. Works for Cloak's public app client (no client secret).
 * Returns the rewritten cookie header, or null when refresh is not possible
 * (no refresh token, revoked, expired, or the client requires a secret).
 */
export async function refreshCloakTokens(env: Env, cookie: string): Promise<string | null> {
  const clientId = cloakCognitoClientId(env);
  const tokens = readCloakTokens(cookie, clientId);
  if (!tokens?.refreshToken) return null;

  let res: Response;
  try {
    res = await fetch(`https://cognito-idp.${cloakCognitoRegion(env)}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: clientId,
        AuthParameters: { REFRESH_TOKEN: tokens.refreshToken },
      }),
    });
  } catch (err) {
    console.warn('cloak cognito refresh network error', err);
    return null;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Never log tokens — Cognito error bodies only carry __type/message.
    console.warn(`cloak cognito refresh HTTP ${res.status}: ${body.slice(0, 200)}`);
    return null;
  }

  const json = (await res.json().catch(() => null)) as {
    AuthenticationResult?: { AccessToken?: string; IdToken?: string; RefreshToken?: string };
  } | null;
  const result = json?.AuthenticationResult;
  if (!result?.AccessToken) return null;

  return withRefreshedTokens(cookie, tokens, {
    accessToken: result.AccessToken,
    idToken: result.IdToken ?? null,
    refreshToken: result.RefreshToken ?? null,
  });
}
