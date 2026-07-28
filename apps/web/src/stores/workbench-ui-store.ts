import { create } from "zustand";
import type { MessageAttachment, ReasoningEffort } from "@/lib/agent-events/types";

export type WorkspaceTab = "plan" | "artifacts" | "files" | "web" | "code" | "logs";
export type PermissionMode = "ask" | "auto" | "read-only";
export type DraftAttachment = MessageAttachment & { file: File };

type WorkbenchUiState = {
  leftPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
  workspaceTab: WorkspaceTab;
  workspaceFullscreen: boolean;
  selectedArtifactId: string | null;
  selectedFileId: string | null;
  selectedToolIds: string[];
  agentId: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  permissionMode: PermissionMode;
  pendingAttachments: MessageAttachment[];
  pendingDraftAttachments: DraftAttachment[];
  setLeftPanelCollapsed: (value: boolean) => void;
  setRightPanelCollapsed: (value: boolean) => void;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  setWorkspaceFullscreen: (value: boolean) => void;
  setSelectedArtifactId: (id: string | null) => void;
  setSelectedFileId: (id: string | null) => void;
  setSelectedToolIds: (ids: string[]) => void;
  setAgentId: (id: string) => void;
  setModel: (id: string, effort: ReasoningEffort) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  addPendingAttachments: (attachments: MessageAttachment[]) => void;
  removePendingAttachment: (id: string) => void;
  clearPendingAttachments: () => void;
  addPendingDraftAttachments: (attachments: DraftAttachment[]) => void;
  removePendingDraftAttachment: (id: string) => void;
  clearPendingDraftAttachments: () => void;
};

export const useWorkbenchUiStore = create<WorkbenchUiState>((set) => ({
  leftPanelCollapsed: false,
  rightPanelCollapsed: true,
  workspaceTab: "artifacts",
  workspaceFullscreen: false,
  selectedArtifactId: null,
  selectedFileId: null,
  selectedToolIds: ["context_read", "task_plan", "calculator", "code_runner"],
  agentId: "assistant",
  modelId: "deepseek-v4-flash",
  reasoningEffort: "medium",
  permissionMode: "ask",
  pendingAttachments: [],
  pendingDraftAttachments: [],
  setLeftPanelCollapsed: (leftPanelCollapsed) => set({ leftPanelCollapsed }),
  setRightPanelCollapsed: (rightPanelCollapsed) => set({ rightPanelCollapsed }),
  setWorkspaceTab: (workspaceTab) => set({ workspaceTab }),
  setWorkspaceFullscreen: (workspaceFullscreen) => set({ workspaceFullscreen }),
  setSelectedArtifactId: (selectedArtifactId) => set({ selectedArtifactId }),
  setSelectedFileId: (selectedFileId) => set({ selectedFileId }),
  setSelectedToolIds: (selectedToolIds) => set({ selectedToolIds: [...new Set(selectedToolIds)] }),
  setAgentId: (agentId) => set({ agentId }),
  setModel: (modelId, reasoningEffort) => set({ modelId, reasoningEffort }),
  setPermissionMode: (permissionMode) => set({ permissionMode }),
  addPendingAttachments: (attachments) => set((state) => ({ pendingAttachments: [...state.pendingAttachments, ...attachments].slice(0, 10) })),
  removePendingAttachment: (id) => set((state) => ({ pendingAttachments: state.pendingAttachments.filter((attachment) => attachment.id !== id) })),
  clearPendingAttachments: () => set({ pendingAttachments: [] }),
  addPendingDraftAttachments: (attachments) => set((state) => ({ pendingDraftAttachments: [...state.pendingDraftAttachments, ...attachments].slice(0, 10) })),
  removePendingDraftAttachment: (id) => set((state) => {
    const removed = state.pendingDraftAttachments.find((attachment) => attachment.id === id);
    if (removed) URL.revokeObjectURL(removed.url);
    return { pendingDraftAttachments: state.pendingDraftAttachments.filter((attachment) => attachment.id !== id) };
  }),
  clearPendingDraftAttachments: () => set((state) => {
    state.pendingDraftAttachments.forEach((attachment) => URL.revokeObjectURL(attachment.url));
    return { pendingDraftAttachments: [] };
  })
}));
