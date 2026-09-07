const CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

export function resolveGoogleClientId(configured: string | undefined, legacy: string | undefined): string {
  for (const value of [configured, legacy]) {
    const normalized = value?.trim() ?? "";
    if (normalized.endsWith(CLIENT_ID_SUFFIX)) return normalized;
  }
  return "";
}
