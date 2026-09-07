import { describe, expect, it } from "vitest";
import { resolveGoogleClientId } from "./google-client-config";

describe("Google OAuth Client ID 구성", () => {
  it("빌드 환경의 Client ID를 우선한다", () => {
    expect(resolveGoogleClientId("build.apps.googleusercontent.com", "legacy.apps.googleusercontent.com"))
      .toBe("build.apps.googleusercontent.com");
  });

  it("기존 사용자가 저장한 값은 마이그레이션용으로 유지한다", () => {
    expect(resolveGoogleClientId("", "legacy.apps.googleusercontent.com"))
      .toBe("legacy.apps.googleusercontent.com");
  });

  it("유효한 Client ID가 없으면 빈 값을 반환한다", () => {
    expect(resolveGoogleClientId("invalid", "")).toBe("");
  });
});
