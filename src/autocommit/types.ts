export type AutoCommitProviderId = "pi" | "codex";

export interface AutoCommitConfig {
  enabled: boolean;
  provider: AutoCommitProviderId;
  afterMutatingToolCalls: number;
  includeUntracked: boolean;
  maxDiffBytes: number;
  refPrefix: string;
  model?: string;
  codexReasoningEffort: string;
  codexFastMode: boolean;
}

export interface WorkspaceOpenedInput {
  workspaceId: string;
  workspaceRoot: string;
}

export type MutatingToolKind = "write" | "edit" | "bash";

export interface BaseToolCallRecordInput {
  workspaceId: string;
  workspaceRoot: string;
  success: boolean;
  createdAt?: string;
}

export interface WriteToolCallRecordInput extends BaseToolCallRecordInput {
  tool: "write";
  path: string;
  additions?: number;
  removals?: number;
}

export interface EditToolCallRecordInput extends BaseToolCallRecordInput {
  tool: "edit";
  path: string;
  additions?: number;
  removals?: number;
  editCount?: number;
}

export interface BashToolCallRecordInput extends BaseToolCallRecordInput {
  tool: "bash";
  command: string;
  workingDirectory: string;
  exitCode?: number;
}

export type ToolCallRecordInput =
  | WriteToolCallRecordInput
  | EditToolCallRecordInput
  | BashToolCallRecordInput;

export type MutationTelemetry =
  | {
      tool: "write";
      path: string;
      additions?: number;
      removals?: number;
      createdAt: string;
    }
  | {
      tool: "edit";
      path: string;
      additions?: number;
      removals?: number;
      editCount?: number;
      createdAt: string;
    }
  | {
      tool: "bash";
      command: string;
      workingDirectory: string;
      exitCode?: number;
      createdAt: string;
    };

export type AutoCommitWorkspaceStatus =
  | "disabled"
  | "active"
  | "not_git"
  | "no_head"
  | "baseline_failed"
  | "blocked";

export interface BaselineStatus {
  stagedPaths: Set<string>;
  unstagedPaths: Set<string>;
  untrackedPaths: Set<string>;
  dirtyPaths: Set<string>;
}

export interface AutoCommitWorkspaceState {
  workspaceId: string;
  workspaceRoot: string;
  gitRoot?: string;
  status: AutoCommitWorkspaceStatus;
  disabledReason?: string;
  baselineRef?: string;
  baselineStatus?: BaselineStatus;
  mutatingToolCallsSinceBaseline: number;
  mutationTelemetry: MutationTelemetry[];
  running: boolean;
  pending: boolean;
  lastLoggedReason?: string;
}

export interface AutoCommitManager {
  initializeWorkspace(input: WorkspaceOpenedInput): Promise<void>;
  recordToolCall(input: ToolCallRecordInput): void;
  close?(): void;
}

export interface ProviderAvailabilityInput {
  workspaceRoot: string;
}

export interface ProviderAvailability {
  available: boolean;
  reason?: string;
}

export interface GenerateCommitMetadataInput {
  workspaceRoot: string;
  diff: string;
  diffStat: string;
  status: string;
  mutations: MutationTelemetry[];
}

export type CommitType =
  | "feat"
  | "fix"
  | "refactor"
  | "docs"
  | "test"
  | "chore"
  | "style"
  | "build"
  | "perf"
  | "ci";

export interface CommitMetadata {
  shouldCommit: boolean;
  type: CommitType;
  scope?: string;
  subject: string;
  body?: string;
  files?: string[];
  reason: string;
  model?: string;
}

export interface AutoCommitProvider {
  id: AutoCommitProviderId;
  isAvailable(input: ProviderAvailabilityInput): Promise<ProviderAvailability>;
  generateCommitMetadata(input: GenerateCommitMetadataInput): Promise<CommitMetadata>;
}
