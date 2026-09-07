import { shouldShowCaption } from "./caption";

interface SpeechCaptionProps {
  captionsEnabled: boolean;
  chatPanelOpen: boolean;
  speaking: boolean;
  text: string;
}

export function SpeechCaption(props: SpeechCaptionProps) {
  if (!shouldShowCaption(props)) return null;

  return (
    <p
      className="speech-caption"
      role="status"
      aria-live="polite"
      style={{ pointerEvents: "none" }}
    >
      {/* 클램프는 안쪽 요소가 담당한다. 바깥 padding과 한 요소에 두면
          넘친 3번째 줄이 padding 영역에 잘린 채 노출된다 (T-009). */}
      <span className="speech-caption-text">{props.text}</span>
    </p>
  );
}
