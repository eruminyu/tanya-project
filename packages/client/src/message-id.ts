interface MessageIdDependencies {
  randomUUID?: () => string;
  now?: () => number;
  random?: () => number;
}

function browserRandomUUID(): (() => string) | undefined {
  if (typeof globalThis.crypto?.randomUUID !== "function") return undefined;
  return () => globalThis.crypto.randomUUID();
}

/**
 * HTTPS/Tauri에서는 표준 UUID를 쓰고, LAN HTTP처럼 Web Crypto가 제한된 환경에서는
 * 페이지를 중단하지 않는 로컬 메시지 ID로 대체한다.
 */
export function createMessageId(dependencies?: MessageIdDependencies): string {
  const randomUUID = dependencies ? dependencies.randomUUID : browserRandomUUID();
  try {
    if (randomUUID) return randomUUID();
  } catch {
    // 일부 WebView는 함수를 노출하고도 호출을 거부하므로 아래 대체 경로를 사용한다.
  }

  const now = dependencies?.now ?? Date.now;
  const random = dependencies?.random ?? Math.random;
  const randomPart = random().toString(36).slice(2, 10) || "0";
  return `local-${now().toString(36)}-${randomPart}`;
}
