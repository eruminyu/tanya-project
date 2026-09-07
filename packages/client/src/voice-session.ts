export type VoiceInputSource = "ptt" | "toggle" | "button";
export type VoiceSession =
  | { state: "idle" }
  | { state: "listening"; source: VoiceInputSource }
  | { state: "processing"; source: VoiceInputSource };

export type VoiceSessionAction =
  | { type: "start"; source: VoiceInputSource }
  | { type: "process" }
  | { type: "stop" };

export const initialVoiceSession: VoiceSession = { state: "idle" };

export function reduceVoiceSession(state: VoiceSession, action: VoiceSessionAction): VoiceSession {
  switch (action.type) {
    case "start":
      return state.state === "idle" ? { state: "listening", source: action.source } : state;
    case "process":
      return state.state === "listening" ? { state: "processing", source: state.source } : state;
    case "stop":
      return initialVoiceSession;
  }
}
