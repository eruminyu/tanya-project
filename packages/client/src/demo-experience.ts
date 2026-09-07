import type { LlmRoute } from "./brain";

export const WEB_DEMO_BOUNDARY = "체험 답변은 Brain 서버 VM의 로컬 Ollama로 처리됩니다. Google 작업은 공용 데모 계정을 사용하며 개인 Google 계정에는 접근하지 않습니다.";

const PROVIDER_LABELS: Record<string, string> = {
  ollama: "Ollama",
  vllm: "vLLM",
  gemini: "Gemini",
  openai: "OpenAI",
  claude: "Claude",
  "openai-compatible": "호환 API",
};

export function describeLlmRoute(route: LlmRoute, surface: "tauri" | "web" = "tauri"): string {
  const mode = route.mode === "casual" ? "일상" : "작업";
  const localExecution = surface === "web" ? "Brain 서버 로컬" : "로컬";
  const execution = route.fallback
    ? `${route.execution === "local" ? localExecution : route.execution === "cloud" ? "클라우드" : "사용자 지정"} 폴백`
    : route.execution === "local"
      ? localExecution
      : route.execution === "cloud"
        ? "클라우드"
        : "사용자 지정";
  const provider = PROVIDER_LABELS[route.provider] ?? route.provider;
  return `${mode} · ${execution} · ${provider}`;
}
