import {
  LIVE2D_FRAMING_PRESETS,
  LIVE2D_OFFSET_RANGE,
  LIVE2D_SCALE_RANGE,
  matchingLive2DFramingPreset,
  type Live2DFraming,
} from "./live2d-framing";

interface Live2DFramingControlsProps {
  framing: Live2DFraming;
  onChange(framing: Live2DFraming): void;
}

interface FramingSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  displayValue: string;
  onChange(value: number): void;
}

function FramingSlider({ label, value, min, max, step, displayValue, onChange }: FramingSliderProps) {
  return (
    <label className="framing-slider">
      <span>{label}<output>{displayValue}</output></span>
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

export function Live2DFramingControls({ framing, onChange }: Live2DFramingControlsProps) {
  const activePreset = matchingLive2DFramingPreset(framing);
  const update = (key: keyof Live2DFraming, value: number) => {
    onChange({ ...framing, [key]: value });
  };

  return (
    <fieldset className="framing-controls">
      <legend>모델 화면</legend>
      <p>자주 쓰는 구도를 고른 뒤 확대와 위치를 미세 조절할 수 있어요.</p>
      <div className="framing-presets" aria-label="모델 화면 프리셋">
        {LIVE2D_FRAMING_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-pressed={activePreset === preset.id}
            onClick={() => onChange({ ...preset.framing })}
          >
            <strong>{preset.label}</strong>
            <span>{preset.description}</span>
          </button>
        ))}
      </div>
      <FramingSlider
        label="확대"
        value={framing.scale}
        min={LIVE2D_SCALE_RANGE.min}
        max={LIVE2D_SCALE_RANGE.max}
        step={0.05}
        displayValue={`${framing.scale.toFixed(2)}×`}
        onChange={(value) => update("scale", value)}
      />
      <FramingSlider
        label="가로 위치"
        value={framing.offsetX}
        min={LIVE2D_OFFSET_RANGE.min}
        max={LIVE2D_OFFSET_RANGE.max}
        step={0.05}
        displayValue={`${Math.round(framing.offsetX * 100)}%`}
        onChange={(value) => update("offsetX", value)}
      />
      <FramingSlider
        label="세로 위치"
        value={framing.offsetY}
        min={LIVE2D_OFFSET_RANGE.min}
        max={LIVE2D_OFFSET_RANGE.max}
        step={0.05}
        displayValue={`${Math.round(framing.offsetY * 100)}%`}
        onChange={(value) => update("offsetY", value)}
      />
    </fieldset>
  );
}
