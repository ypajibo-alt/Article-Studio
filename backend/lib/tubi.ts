import Base64Encoder from 'crypto-js/enc-base64.js';
import HexEncoder from 'crypto-js/enc-hex.js';
import Utf8Encoder from 'crypto-js/enc-utf8.js';
import HmacSHA256 from 'crypto-js/hmac-sha256.js';
import WordArray from 'crypto-js/lib-typedarrays.js';
import SHA256 from 'crypto-js/sha256.js';
import { jwtDecode } from 'jwt-decode';

const TUBI_DEFAULT_DEVICE_ID = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
const TUBI_ALGORITHM = 'TUBI-HMAC-SHA256';
const TUBI_PLATFORM = 'chatgpt';
const TUBI_SIGNED_HEADERS = 'content-type';
const TUBI_CANONICAL_REQUEST_TOKEN_URL = '/device/anonymous/token';
const TUBI_CLIENT_VERSION = '1.0.0';
const TUBI_CLIENT_KEY_STATIC_VALUE = 'TUBI';
const TUBI_DERIVED_KEY_MESSAGE = 'tubi_request';
const TOKEN_REQUEST_EXPIRE_TIME = 30;
const EXPIRE_BUFFER_TIME_SECONDS = 30;

const ACCOUNT_SERVICE_PREFIX = 'https://account.production-public.tubi.io';
const SIGNING_KEY_URL = `${ACCOUNT_SERVICE_PREFIX}/device/anonymous/signing_key`;
const TOKEN_URL = `${ACCOUNT_SERVICE_PREFIX}/device/anonymous/token`;
const CONTENT_API_BASE = 'https://content-cdn.production-public.tubi.io/api/v2/contents';

interface TokenPayload { exp: number; tubi_id: string }
interface TokenResponse { access_token: string; refresh_token: string; expires_in: number }
interface SigningKeyResponse { id: string; key: string }

// Token cache with pending-promise guard to prevent parallel refresh races
let cachedToken: string | null = null;
let cachedTokenExp = 0;
let pendingTokenFetch: Promise<string | null> | null = null;

function getDateISO(): string {
  return new Date().toISOString().split('.')[0].concat('Z').replace(/[^A-Za-z0-9]/g, '');
}

function generateCodeVerifier(): string {
  try {
    const v = WordArray.random(16).toString(HexEncoder);
    if (!v) throw new Error('empty verifier');
    return v;
  } catch { return TUBI_DEFAULT_DEVICE_ID; }
}

function makeBase64UrlSafe(str: string): string {
  return str.replace(/[+/]/g, (c) => ({ '+': '-', '/': '_' }[c] ?? c));
}

function generateCodeChallenge(verifier: string): string {
  try {
    const c = makeBase64UrlSafe(SHA256(verifier).toString(Base64Encoder));
    if (!c) throw new Error('empty challenge');
    return c;
  } catch { return ''; }
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 30_000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

function buildQueryParams(payload: { verifier: string; id: string; platform: string; device_id: string }, clientKey: CryptoJS.lib.WordArray) {
  const canonicalHeaders = 'content-type:application/json\n';
  const hashedPayload = SHA256(JSON.stringify(payload)).toString(HexEncoder).toLowerCase();
  const canonicalRequest = `POST\n${TUBI_CANONICAL_REQUEST_TOKEN_URL}\n\n${canonicalHeaders}\n${TUBI_SIGNED_HEADERS}\n${hashedPayload}`;
  const hashedCanonical = SHA256(canonicalRequest).toString(HexEncoder).toLowerCase();
  const isoDate = getDateISO();
  const stringToSign = `${TUBI_ALGORITHM}\n${isoDate}\n${hashedCanonical}`;
  let key = Utf8Encoder.parse(TUBI_CLIENT_KEY_STATIC_VALUE).concat(clientKey);
  let derivedKey: CryptoJS.lib.WordArray = HmacSHA256(isoDate.split('T')[0], key);
  derivedKey = HmacSHA256(TUBI_DERIVED_KEY_MESSAGE, derivedKey);
  return {
    'X-Tubi-Algorithm': TUBI_ALGORITHM, 'X-Tubi-Date': isoDate,
    'X-Tubi-Expires': TOKEN_REQUEST_EXPIRE_TIME, 'X-Tubi-SignedHeaders': TUBI_SIGNED_HEADERS,
    'X-Tubi-Signature': HmacSHA256(stringToSign, derivedKey).toString(HexEncoder),
  };
}

async function generateFreshToken(deviceId = TUBI_DEFAULT_DEVICE_ID): Promise<string | null> {
  try {
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    if (!challenge) return null;

    const skRes = await fetchWithTimeout(SIGNING_KEY_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge, version: TUBI_CLIENT_VERSION, platform: TUBI_PLATFORM, device_id: deviceId }),
    });
    if (!skRes.ok) return null;
    const sk: SigningKeyResponse = await skRes.json();

    const clientKey = Base64Encoder.parse(sk.key);
    const payload = { verifier, id: sk.id, platform: TUBI_PLATFORM, device_id: deviceId };
    const queryParams = buildQueryParams(payload, clientKey);
    const urlParams = new URLSearchParams(Object.entries(queryParams).map(([k, v]) => [k, String(v)]));

    const tokRes = await fetchWithTimeout(`${TOKEN_URL}?${urlParams}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!tokRes.ok) return null;
    const tok: TokenResponse = await tokRes.json();
    return tok.access_token;
  } catch {
    return null;
  }
}

export async function getToken(): Promise<string | null> {
  if (cachedToken) {
    try {
      const exp = jwtDecode<TokenPayload>(cachedToken).exp;
      if (Date.now() / 1000 + EXPIRE_BUFFER_TIME_SECONDS < exp) return cachedToken;
    } catch { /* fall through */ }
  }
  if (!pendingTokenFetch) {
    pendingTokenFetch = generateFreshToken()
      .then(token => {
        if (token) {
          cachedToken = token;
          try { cachedTokenExp = jwtDecode<TokenPayload>(token).exp; } catch { cachedTokenExp = 0; }
        }
        return token;
      })
      .finally(() => { pendingTokenFetch = null; });
  }
  return pendingTokenFetch;
}

export interface TubiContentAvailability {
  contentId: string;
  title: string;
  availability_starts: string | null;
  availability_ends: string | null;
  type: string;
}

export async function fetchContentAvailability(contentIds: string[]): Promise<TubiContentAvailability[]> {
  if (!contentIds.length) return [];

  const token = await getToken();
  if (!token) throw new Error('Could not obtain Tubi token');

  const batchSize = 50;
  const batches: string[][] = [];
  for (let i = 0; i < contentIds.length; i += batchSize) {
    batches.push(contentIds.slice(i, i + batchSize));
  }

  const fetchBatch = async (batch: string[]): Promise<TubiContentAvailability[]> => {
    const url = `${CONTENT_API_BASE}?content_ids=${batch.join(',')}`;
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { console.error(`Tubi content API failed: ${res.status}`); return []; }
    const data = await res.json() as Record<string, Record<string, unknown> | null>;
    const out: TubiContentAvailability[] = [];
    for (const [rawKey, item] of Object.entries(data)) {
      if (!item) continue;
      const contentId = String(parseInt(rawKey, 10));
      out.push({
        contentId,
        title: String(item.title ?? ''),
        availability_starts: (item.availability_starts as string) ?? null,
        availability_ends: (item.availability_ends as string) ?? null,
        type: String(item.type ?? ''),
      });
    }
    return out;
  };

  const results = (await Promise.all(batches.map(fetchBatch))).flat();
  return results;
}

export function extractContentId(tubiLink: string): string | null {
  const m = tubiLink.match(/(\d+)$/);
  return m ? m[1] : null;
}
