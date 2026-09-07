import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  parseClientSettings,
  parseClientSettingsPayload,
  serializeClientSettings,
} from "./client-settings";

describe("클라이언트 설정", () => {
  it("저장값이 없거나 손상되면 기본값을 사용한다", () => {
    expect(parseClientSettings(null)).toEqual(DEFAULT_CLIENT_SETTINGS);
    expect(parseClientSettings("not-json")).toEqual(DEFAULT_CLIENT_SETTINGS);
  });

  it("립싱크와 Live2D 구도 설정을 직렬화하고 복원한다", () => {
    const settings = {
      lipSyncSensitivity: 6,
      lipSyncSmoothing: 0.7,
      lipSyncMaxOpen: 0.8,
      live2dScale: 1.3,
      live2dOffsetX: 0.15,
      live2dOffsetY: -0.25,
    };

    expect(parseClientSettings(serializeClientSettings(settings))).toEqual(settings);
  });

  it("범위를 벗어나거나 유효하지 않은 값은 안전 범위로 보정한다", () => {
    const parsed = parseClientSettings(JSON.stringify({
      lipSyncSensitivity: 100,
      lipSyncSmoothing: -1,
      lipSyncMaxOpen: "invalid",
      live2dScale: 9,
      live2dOffsetX: -4,
      live2dOffsetY: "invalid",
    }));

    expect(parsed).toEqual({
      lipSyncSensitivity: 10,
      lipSyncSmoothing: 0,
      lipSyncMaxOpen: DEFAULT_CLIENT_SETTINGS.lipSyncMaxOpen,
      live2dScale: 3.5,
      live2dOffsetX: -2.5,
      live2dOffsetY: DEFAULT_CLIENT_SETTINGS.live2dOffsetY,
    });
  });

  it("기존 v1 립싱크 저장값에는 새 흉상 기본 구도를 채운다", () => {
    expect(parseClientSettings(JSON.stringify({
      lipSyncSensitivity: 5,
      lipSyncSmoothing: 0.4,
      lipSyncMaxOpen: 0.9,
    }))).toEqual({
      ...DEFAULT_CLIENT_SETTINGS,
      lipSyncSensitivity: 5,
      lipSyncSmoothing: 0.4,
      lipSyncMaxOpen: 0.9,
    });
  });

  it("다른 Tauri 창에서 전달된 통합 설정 payload의 립싱크 값을 검증한다", () => {
    expect(parseClientSettingsPayload({
      clientSettings: {
        lipSyncSensitivity: 7,
        lipSyncSmoothing: 0.25,
        lipSyncMaxOpen: 0.8,
        live2dScale: 1,
        live2dOffsetX: 0.1,
        live2dOffsetY: 0.2,
      },
    })).toEqual({
      lipSyncSensitivity: 7,
      lipSyncSmoothing: 0.25,
      lipSyncMaxOpen: 0.8,
      live2dScale: 1,
      live2dOffsetX: 0.1,
      live2dOffsetY: 0.2,
    });
    expect(parseClientSettingsPayload({ clientSettings: { lipSyncSensitivity: 100 } }))
      .toEqual({
        lipSyncSensitivity: 10,
        lipSyncSmoothing: DEFAULT_CLIENT_SETTINGS.lipSyncSmoothing,
        lipSyncMaxOpen: DEFAULT_CLIENT_SETTINGS.lipSyncMaxOpen,
        live2dScale: DEFAULT_CLIENT_SETTINGS.live2dScale,
        live2dOffsetX: DEFAULT_CLIENT_SETTINGS.live2dOffsetX,
        live2dOffsetY: DEFAULT_CLIENT_SETTINGS.live2dOffsetY,
      });
    expect(parseClientSettingsPayload(null)).toEqual(DEFAULT_CLIENT_SETTINGS);
  });
});
