export type Live2DEmotion =
  | "neutral"
  | "happy"
  | "sad"
  | "excited"
  | "worried"
  | "annoyed"
  | "affectionate";

export const LIVE2D_EMOTIONS: readonly Live2DEmotion[] = [
  "neutral", "happy", "sad", "excited", "worried", "annoyed", "affectionate",
];

const EMOTION_ALIASES: Record<string, Live2DEmotion> = {
  neutral: "neutral",
  happy: "happy",
  joy: "happy",
  sad: "sad",
  excited: "excited",
  surprised: "excited",
  worried: "worried",
  anxious: "worried",
  annoyed: "annoyed",
  angry: "annoyed",
  affectionate: "affectionate",
  love: "affectionate",
};

export function normalizeLive2DEmotion(value: string | undefined): Live2DEmotion {
  if (!value) return "neutral";
  return EMOTION_ALIASES[value.trim().toLowerCase()] ?? "neutral";
}
