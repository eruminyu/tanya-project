import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
} from "./client-settings";
import { Live2DFramingControls } from "./Live2DFramingControls";

interface SettingsPanelProps {
  settings: ClientSettings;
  onChange(settings: ClientSettings): void;
  onClose(): void;
}

interface SliderProps {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  displayValue: string;
  onChange(value: number): void;
}

function SettingSlider({
  label,
  description,
  value,
  min,
  max,
  step,
  displayValue,
  onChange,
}: SliderProps) {
  return (
    <label className="setting-control">
      <span className="setting-label">
        <strong>{label}</strong>
        <output>{displayValue}</output>
      </span>
      <span className="setting-description">{description}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function SettingsPanel({ settings, onChange, onClose }: SettingsPanelProps) {
  const update = (key: keyof ClientSettings, value: number) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <aside id="client-settings-panel" className="settings-panel" aria-label="클라이언트 설정">
      <div className="settings-heading">
        <div>
          <strong>설정</strong>
          <span>Live2D 화면과 립싱크</span>
        </div>
        <button type="button" onClick={onClose} aria-label="설정 닫기">×</button>
      </div>

      <Live2DFramingControls
        framing={{
          scale: settings.live2dScale,
          offsetX: settings.live2dOffsetX,
          offsetY: settings.live2dOffsetY,
        }}
        onChange={(framing) => onChange({
          ...settings,
          live2dScale: framing.scale,
          live2dOffsetX: framing.offsetX,
          live2dOffsetY: framing.offsetY,
        })}
      />

      <SettingSlider
        label="립싱크 민감도"
        description="작은 목소리에 반응하는 정도"
        value={settings.lipSyncSensitivity}
        min={1}
        max={10}
        step={0.1}
        displayValue={settings.lipSyncSensitivity.toFixed(1)}
        onChange={(value) => update("lipSyncSensitivity", value)}
      />
      <SettingSlider
        label="입 움직임 부드러움"
        description="높을수록 천천히 열리고 닫힘"
        value={settings.lipSyncSmoothing}
        min={0}
        max={1}
        step={0.05}
        displayValue={`${Math.round(settings.lipSyncSmoothing * 100)}%`}
        onChange={(value) => update("lipSyncSmoothing", value)}
      />
      <SettingSlider
        label="최대 입 벌림"
        description="가장 큰 소리에서 벌어지는 한도"
        value={settings.lipSyncMaxOpen}
        min={0.2}
        max={1}
        step={0.05}
        displayValue={`${Math.round(settings.lipSyncMaxOpen * 100)}%`}
        onChange={(value) => update("lipSyncMaxOpen", value)}
      />

      <button
        className="settings-reset"
        type="button"
        onClick={() => onChange({ ...DEFAULT_CLIENT_SETTINGS })}
      >기본값 복원</button>
    </aside>
  );
}
