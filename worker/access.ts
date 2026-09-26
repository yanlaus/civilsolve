// Who may call the API: Cloudflare Access signs every user in at the edge,
// and this module checks the proof it attaches to each request.
//
// Access in front of the Worker is the gate; this check is the lock behind
// it. A request that reaches the Worker without passing Access - a hostname
// Access does not cover (the workers.dev address, a preview URL), or an
// application that was deleted or misconfigured - carries no valid token and
// is refused here, so the provider keys are never spent on it. Access puts
// the token in the `Cf-Access-Jwt-Assertion` header: an RS256 JWT signed with
// the team's keys, whose `aud` names the Access application.
//
// With ACCESS_TEAM_DOMAIN or ACCESS_AUD unset the API refuses everything
// (fail closed), except for requests to localhost - `npm run dev` and
// `npm run preview`, which Access never sees. Cloudflare routes a request by
// its hostname, so no request that reaches a deployed Worker can claim to be
// for localhost.

export type AccessEnv = {
  /** The Zero Trust team domain, e.g. "yourteam.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's Audience (AUD) tag. */
  ACCESS_AUD?: string;
};

/** Who the request is from: the signed-in email, or a service token's id. */
export type AccessIdentity = { user: string };

export type AccessCheck =
  | { ok: true; identity: AccessIdentity }
  | { ok: false; status: 401 | 503; error: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Tolerated clock difference between Access and this Worker, in seconds. */
const CLOCK_SKEW_S = 60;

/** How long fetched signing keys are trusted before they are fetched again. */
const KEYS_TTL_MS = 60 * 60 * 1000;

/**
 * A token signed with a key we do not have yet (Access rotates its keys)
 * refetches them at once, but no more often than this, so a flood of made-up
 * key ids cannot turn into a flood of fetches.
 */
const FORCED_REFRESH_MS = 60 * 1000;

type SigningKeys = { domain: string; fetchedAt: number; keys: Map<string, CryptoKey> };

// Per isolate: a warm Worker verifies without fetching the keys every time.
let cachedKeys: SigningKeys | null = null;
let lastForcedRefresh = 0;

function normalizeTeamDomain(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function base64UrlBytes(segment: string): Uint8Array {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function base64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlBytes(segment))) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function fetchSigningKeys(domain: string): Promise<SigningKeys> {
  const response = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!response.ok) {
    throw new Error(`Access signing keys: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of payload.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  return { domain, fetchedAt: Date.now(), keys };
}

async function signingKey(domain: string, kid: string): Promise<CryptoKey | null> {
  const fresh =
    cachedKeys && cachedKeys.domain === domain && Date.now() - cachedKeys.fetchedAt < KEYS_TTL_MS;
  if (!fresh) cachedKeys = await fetchSigningKeys(domain);
  const known = cachedKeys?.keys.get(kid);
  if (known) return known;

  if (Date.now() - lastForcedRefresh < FORCED_REFRESH_MS) return null;
  lastForcedRefresh = Date.now();
  cachedKeys = await fetchSigningKeys(domain);
  return cachedKeys.keys.get(kid) ?? null;
}

/**
 * Verifies an Access token: signature, audience, issuer and lifetime.
 * Returns who it was issued to, or null when it does not hold up.
 */
export async function verifyAccessToken(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<AccessIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = base64UrlJson(headerPart);
  const payload = base64UrlJson(payloadPart);
  if (!header || !payload) return null;
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const domain = normalizeTeamDomain(teamDomain);
  const key = await signingKey(domain, header.kid);
  if (!key) return null;

  let signature: Uint8Array;
  try {
    signature = base64UrlBytes(signaturePart);
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) return null;

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(audience)) return null;
  if (payload.iss !== `https://${domain}`) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now - CLOCK_SKEW_S) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + CLOCK_SKEW_S) return null;

  // A person signs in with an email; a service token carries a common_name.
  const user =
    typeof payload.email === "string" && payload.email
      ? payload.email
      : typeof payload.common_name === "string" && payload.common_name
        ? payload.common_name
        : typeof payload.sub === "string"
          ? payload.sub
          : "";
  return user ? { user } : null;
}

/** Decides whether `request` may use the API. */
export async function checkAccess(request: Request, env: AccessEnv): Promise<AccessCheck> {
  if (LOCAL_HOSTS.has(new URL(request.url).hostname)) {
    return { ok: true, identity: { user: "local" } };
  }

  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.ACCESS_AUD?.trim();
  if (!teamDomain || !audience) {
    return {
      ok: false,
      status: 503,
      error:
        "Sign-in is not set up on the server yet (ACCESS_TEAM_DOMAIN and ACCESS_AUD), so the API is closed.",
    };
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "You are not signed in. Reload the page to sign in.",
    };
  }

  let identity: AccessIdentity | null;
  try {
    identity = await verifyAccessToken(token, teamDomain, audience);
  } catch {
    return {
      ok: false,
      status: 503,
      error: "Could not check your sign-in just now. Try again in a moment.",
    };
  }
  return identity
    ? { ok: true, identity }
    : {
        ok: false,
        status: 401,
        error: "Your sign-in has expired or is not valid here. Reload the page to sign in again.",
      };
}
