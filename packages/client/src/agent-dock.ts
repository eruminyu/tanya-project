export type AgentActivityStatus = "running" | "waiting" | "completed" | "failed";

export interface AgentActivity {
  skill: string;
  title: string;
  summary: string;
  status: AgentActivityStatus;
  sources: string[];
  approvalToken?: string;
  approvalEnabled: false;
}

export interface AgentDockState { open: boolean; activity: AgentActivity | null }

export type AgentDockAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "approval-required"; skill: string; reason: string; approvalToken: string }
  | { type: "skill-result"; skill: string; summary: string; sources: string[] }
  | { type: "failed"; skill: string; message: string };

export const initialAgentDockState: AgentDockState = { open: false, activity: null };

function skillTitle(skill: string): string { return skill.replaceAll("_", " ").trim() || "에이전트 작업"; }

export function reduceAgentDockState(state: AgentDockState, action: AgentDockAction): AgentDockState {
  switch (action.type) {
    case "open": return { ...state, open: true };
    case "close": return { ...state, open: false };
    case "approval-required": return { open: true, activity: { skill: action.skill, title: skillTitle(action.skill), summary: action.reason, status: "waiting", sources: [], approvalToken: action.approvalToken, approvalEnabled: false } };
    case "skill-result": return { open: true, activity: { skill: action.skill, title: skillTitle(action.skill), summary: action.summary, status: "completed", sources: action.sources, approvalEnabled: false } };
    case "failed": return { open: true, activity: { skill: action.skill, title: skillTitle(action.skill), summary: action.message, status: "failed", sources: [], approvalEnabled: false } };
  }
}
