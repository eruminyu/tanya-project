const WEBCHAT_SESSION_STORAGE_KEY = "tanya.webchatSessionId";
const WEBCHAT_SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;
const SECURE_WEBCHAT_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SessionStorageLike = Pick<Storage, "getItem" | "setItem">;

type SessionIdDependencies = {
  storage?: SessionStorageLike | null;
  randomUUID?: (() => string) | null;
  fillRandomBytes?: ((bytes: Uint8Array) => void) | null;
  now?: () => number;
  random?: () => number;
};

function browserSessionStorage(): SessionStorageLike | null {
  try {
    return typeof globalThis.sessionStorage === "undefined"
      ? null
      : globalThis.sessionStorage;
  } catch {
    // Storage can be disabled by the browser or WebView privacy policy.
    return null;
  }
}

function browserRandomUUID(): (() => string) | null {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? () => globalThis.crypto.randomUUID()
    : null;
}

function browserFillRandomBytes(): ((bytes: Uint8Array) => void) | null {
  return typeof globalThis.crypto?.getRandomValues === "function"
    ? (bytes) => { globalThis.crypto.getRandomValues(bytes); }
    : null;
}

function uuidFromRandomBytes(fillRandomBytes: (bytes: Uint8Array) => void): string {
  const bytes = new Uint8Array(16);
  fillRandomBytes(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Prefer a cryptographically random UUID. Older/insecure WebViews may expose
 * getRandomValues without randomUUID, so construct an RFC 4122 v4 UUID there.
 * The final non-cryptographic local fallback is only a compatibility identifier
 * for environments where Web Crypto is entirely blocked.
 */
export function createWebchatSessionId(dependencies: SessionIdDependencies = {}): string {
  const randomUUID = "randomUUID" in dependencies
    ? dependencies.randomUUID
    : browserRandomUUID();
  try {
    const candidate = randomUUID?.();
    if (candidate && WEBCHAT_SESSION_ID_PATTERN.test(candidate)) return candidate;
  } catch {
    // Some WebViews expose randomUUID but reject calls outside a secure context.
  }

  const fillRandomBytes = "fillRandomBytes" in dependencies
    ? dependencies.fillRandomBytes
    : browserFillRandomBytes();
  try {
    if (fillRandomBytes) return uuidFromRandomBytes(fillRandomBytes);
  } catch {
    // Continue with the non-crypto compatibility fallback below.
  }

  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;
  const randomPart = Array.from({ length: 4 }, () => {
    const sample = random();
    const normalized = Number.isFinite(sample)
      ? Math.min(Math.max(sample, 0), 1 - Number.EPSILON)
      : 0;
    return Math.floor(normalized * 0x1_0000_0000).toString(16).padStart(8, "0");
  }).join("");
  return `local-${now().toString(36)}-${randomPart}`;
}

/**
 * sessionStorage is scoped to a browser tab/WebView page session: reconnects
 * and component remounts reuse the ID, while independent tabs get separate IDs.
 */
export function getOrCreateWebchatSessionId(dependencies: SessionIdDependencies = {}): string {
  const storage = "storage" in dependencies
    ? dependencies.storage
    : browserSessionStorage();
  try {
    const stored = storage?.getItem(WEBCHAT_SESSION_STORAGE_KEY);
    if (stored && WEBCHAT_SESSION_ID_PATTERN.test(stored)) return stored;
  } catch {
    // Keep an in-memory ID at the hook level when storage access is blocked.
  }

  const sessionId = createWebchatSessionId(dependencies);
  try {
    storage?.setItem(WEBCHAT_SESSION_STORAGE_KEY, sessionId);
  } catch {
    // A usable connection does not depend on storage being writable.
  }
  return sessionId;
}

/**
 * 공개 기억은 브라우저 탭을 소유자 경계로 쓰므로 Web Crypto에서 만든 UUID v4만
 * 허용한다. 일반 대화용 `local-` 호환 식별자는 계속 연결에 쓸 수 있지만 기억
 * 저장·검색·삭제에는 사용하지 않는다.
 */
export function isSecureWebchatSessionId(sessionId: string): boolean {
  return SECURE_WEBCHAT_SESSION_ID_PATTERN.test(sessionId);
}
