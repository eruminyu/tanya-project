import { isAbsolute, relative, resolve, extname } from 'node:path';
export const APP_URL = 'kirian://app/index.html';
export const PRODUCTION_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none';";
export function resolveAsset(
  rendererRoot: string,
  requestUrl: string
): string | null {
  try {
    const url = new URL(requestUrl);
    if (
      url.protocol !== 'kirian:' ||
      url.hostname !== 'app' ||
      url.port ||
      url.username ||
      url.password
    )
      return null;
    const path = decodeURIComponent(url.pathname);
    if (!/^\/[\p{L}\p{N}/_. ()-]+$/u.test(path)) return null;
    const candidate = resolve(rendererRoot, '.' + path);
    const offset = relative(rendererRoot, candidate);
    if (offset.startsWith('..') || isAbsolute(offset)) return null;
    if (['.json', '.moc3', '.vert', '.frag'].includes(extname(candidate)) && !path.startsWith('/live2d/')) return null;
    if (
      !['.html', '.js', '.css', '.svg', '.png', '.ico', '.woff2', '.json', '.moc3', '.vert', '.frag'].includes(
        extname(candidate)
      )
    )
      return null;
    return candidate;
  } catch {
    return null;
  }
}
export function isRendererDocument(url: string, expectedUrl: string): boolean {
  try {
    const candidate = new URL(url);
    const expected = new URL(expectedUrl);
    return (
      candidate.origin === expected.origin &&
      candidate.protocol === expected.protocol &&
      candidate.hostname === expected.hostname &&
      candidate.port === expected.port &&
      candidate.pathname === expected.pathname &&
      !candidate.username &&
      !candidate.password &&
      candidate.search === expected.search
    );
  } catch {
    return false;
  }
}
export function validText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 32768
  );
}
