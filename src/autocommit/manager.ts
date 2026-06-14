import type { AutoCommitConfig } from "./types.js";
import {
  baselineRef,
  candidateRef,
  captureCheckpoint,
  createCommit,
  deleteRef,
  diffCheckpoints,
  getGitEligibility,
  getGitOperationState,
  hasStagedChanges,
  parseStatusPorcelainZ,
  stagePaths,
  statusPorcelain,
  statusPorcelainZ,
} from "./git.js";
import { createAutoCommitProvider, generateWithProvider } from "./providers.js";
import type {
  AutoCommitManager,
  AutoCommitProvider,
  AutoCommitWorkspaceState,
  CommitMetadata,
  MutationTelemetry,
  ToolCallRecordInput,
  WorkspaceOpenedInput,
} from "./types.js";

interface CreateAutoCommitManagerInput {
  config: AutoCommitConfig;
}

export function createAutoCommitManager(input: CreateAutoCommitManagerInput): AutoCommitManager {
  return new DefaultAutoCommitManager(input.config);
}

class DefaultAutoCommitManager implements AutoCommitManager {
  private readonly states = new Map<string, AutoCommitWorkspaceState>();
  private readonly provider: AutoCommitProvider;

  constructor(private readonly config: AutoCommitConfig) {
    this.provider = createAutoCommitProvider(config.provider, {
      model: config.model,
      codexReasoningEffort: config.codexReasoningEffort,
      codexFastMode: config.codexFastMode,
    });
  }

  async initializeWorkspace(input: WorkspaceOpenedInput): Promise<void> {
    if (!this.config.enabled) {
      this.states.set(input.workspaceId, disabledState(input, "autocommit is disabled"));
      return;
    }

    const state: AutoCommitWorkspaceState = {
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      status: "active",
      mutatingToolCallsSinceBaseline: 0,
      mutationTelemetry: [],
      running: false,
      pending: false,
    };
    this.states.set(input.workspaceId, state);

    const eligibility = await getGitEligibility(input.workspaceRoot);
    if (!eligibility.ok) {
      state.status = eligibility.reason === "not_git" ? "not_git" : "no_head";
      state.disabledReason = eligibility.message;
      this.logOnce(state, eligibility.message ?? state.status);
      return;
    }

    state.gitRoot = eligibility.gitRoot;
    const gitState = await getGitOperationState(eligibility.gitRoot!);
    if (gitState.inProgress) {
      state.status = "blocked";
      state.disabledReason = `git operation in progress: ${gitState.reason}`;
      this.logOnce(state, state.disabledReason);
      return;
    }

    const baselineStatus = parseStatusPorcelainZ(await statusPorcelainZ(eligibility.gitRoot!));
    if (baselineStatus.stagedPaths.size > 0) {
      state.status = "blocked";
      state.baselineStatus = baselineStatus;
      state.disabledReason = "pre-existing staged changes detected";
      this.logOnce(state, state.disabledReason);
      return;
    }

    try {
      state.baselineStatus = baselineStatus;
      state.baselineRef = baselineRef(this.config.refPrefix, input.workspaceId);
      await captureCheckpoint(eligibility.gitRoot!, state.baselineRef);
    } catch (error) {
      state.status = "baseline_failed";
      state.disabledReason = errorMessage(error);
      this.logOnce(state, `baseline capture failed: ${state.disabledReason}`);
    }
  }

  recordToolCall(input: ToolCallRecordInput): void {
    if (!this.config.enabled || !input.success) return;

    const state = this.states.get(input.workspaceId);
    if (!state || state.status !== "active") return;

    state.mutatingToolCallsSinceBaseline++;
    state.mutationTelemetry.push(toMutationTelemetry(input));
    if (state.mutationTelemetry.length > 50) {
      state.mutationTelemetry.splice(0, state.mutationTelemetry.length - 50);
    }

    if (state.mutatingToolCallsSinceBaseline >= this.config.afterMutatingToolCalls) {
      this.enqueue(input.workspaceId);
    }
  }

  private enqueue(workspaceId: string): void {
    const state = this.states.get(workspaceId);
    if (!state || state.status !== "active") return;

    if (state.running) {
      state.pending = true;
      return;
    }

    if (state.pending) return;
    state.pending = true;
    queueMicrotask(() => void this.runWorkspaceJob(workspaceId));
  }

  private async runWorkspaceJob(workspaceId: string): Promise<void> {
    const state = this.states.get(workspaceId);
    if (!state || state.running || state.status !== "active") return;

    state.pending = false;
    state.running = true;
    try {
      await this.maybeCommitWorkspace(state);
    } catch (error) {
      this.logOnce(state, `autocommit failed: ${errorMessage(error)}`);
    } finally {
      state.running = false;
      if (state.pending) queueMicrotask(() => void this.runWorkspaceJob(workspaceId));
    }
  }

  private async maybeCommitWorkspace(state: AutoCommitWorkspaceState): Promise<void> {
    if (!state.gitRoot || !state.baselineRef) return;

    const gitState = await getGitOperationState(state.gitRoot);
    if (gitState.inProgress) {
      this.logOnce(state, `skipped: git operation in progress: ${gitState.reason}`);
      return;
    }

    if (await hasStagedChanges(state.gitRoot)) {
      this.logOnce(state, "skipped: staged changes are present");
      return;
    }

    const candidateA = candidateRef(this.config.refPrefix, state.workspaceId);
    const checkpointA = await captureCheckpoint(state.gitRoot, candidateA);
    const diffA = await diffCheckpoints(state.gitRoot, state.baselineRef, checkpointA.ref);

    try {
      if (diffA.patch.length === 0) {
        await this.refreshBaseline(state);
        return;
      }

      if (byteLength(diffA.patch) > this.config.maxDiffBytes) {
        this.logOnce(state, "skipped: diff exceeds DEVSPACE_AUTOCOMMIT_MAX_DIFF_BYTES");
        return;
      }

      const providerResult = await generateWithProvider(this.provider, {
        workspaceRoot: state.workspaceRoot,
        diff: diffA.patch,
        diffStat: diffA.stat,
        status: await statusPorcelain(state.gitRoot),
        mutations: state.mutationTelemetry,
      });

      if (!providerResult || !providerResult.metadata.shouldCommit) {
        this.logOnce(state, "skipped: no provider produced commit metadata");
        return;
      }

      const candidateB = candidateRef(this.config.refPrefix, state.workspaceId);
      const checkpointB = await captureCheckpoint(state.gitRoot, candidateB);
      const diffB = await diffCheckpoints(state.gitRoot, state.baselineRef, checkpointB.ref);
      await deleteRef(state.gitRoot, checkpointB.ref);

      if (diffA.hash !== diffB.hash) {
        state.pending = true;
        return;
      }

      const safePaths = safeCommitPaths({
        baselineStatus: state.baselineStatus,
        currentStatus: parseStatusPorcelainZ(await statusPorcelainZ(state.gitRoot)),
        checkpointPaths: diffA.paths,
        includeUntracked: this.config.includeUntracked,
        metadata: providerResult.metadata,
        mutations: state.mutationTelemetry,
      });

      if (safePaths.length === 0) {
        this.logOnce(state, "skipped: no safe DevSpace-owned paths to commit");
        return;
      }

      if (await hasStagedChanges(state.gitRoot)) {
        this.logOnce(state, "skipped: staged changes appeared before commit");
        return;
      }

      await stagePaths(state.gitRoot, safePaths);
      const message = formatCommitMessage({
        metadata: providerResult.metadata,
        provider: providerResult.provider.id,
        workspaceId: state.workspaceId,
        toolCalls: state.mutatingToolCallsSinceBaseline,
      });
      const commitSha = await createCommit(state.gitRoot, message.subject, message.body);
      console.log(`[devspace autocommit] committed ${state.workspaceId} ${commitSha.slice(0, 7)} ${message.subject}`);
      await this.refreshBaseline(state);
    } finally {
      await deleteRef(state.gitRoot, checkpointA.ref);
    }
  }

  private async refreshBaseline(state: AutoCommitWorkspaceState): Promise<void> {
    if (!state.gitRoot || !state.baselineRef) return;
    state.baselineStatus = parseStatusPorcelainZ(await statusPorcelainZ(state.gitRoot));
    await captureCheckpoint(state.gitRoot, state.baselineRef);
    state.mutatingToolCallsSinceBaseline = 0;
    state.mutationTelemetry = [];
    state.lastLoggedReason = undefined;
  }

  private logOnce(state: AutoCommitWorkspaceState, reason: string): void {
    if (state.lastLoggedReason === reason) return;
    state.lastLoggedReason = reason;
    console.log(`[devspace autocommit] ${state.workspaceId}: ${reason}`);
  }
}

function disabledState(input: WorkspaceOpenedInput, reason: string): AutoCommitWorkspaceState {
  return {
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    status: "disabled",
    disabledReason: reason,
    mutatingToolCallsSinceBaseline: 0,
    mutationTelemetry: [],
    running: false,
    pending: false,
  };
}

function toMutationTelemetry(input: ToolCallRecordInput): MutationTelemetry {
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (input.tool === "bash") {
    return {
      tool: "bash",
      command: input.command,
      workingDirectory: input.workingDirectory,
      exitCode: input.exitCode,
      createdAt,
    };
  }

  if (input.tool === "edit") {
    return {
      tool: "edit",
      path: input.path,
      additions: input.additions,
      removals: input.removals,
      editCount: input.editCount,
      createdAt,
    };
  }

  return {
    tool: "write",
    path: input.path,
    additions: input.additions,
    removals: input.removals,
    createdAt,
  };
}

function safeCommitPaths(input: {
  baselineStatus: AutoCommitWorkspaceState["baselineStatus"];
  currentStatus: AutoCommitWorkspaceState["baselineStatus"];
  checkpointPaths: string[];
  includeUntracked: boolean;
  metadata: CommitMetadata;
  mutations: MutationTelemetry[];
}): string[] {
  const baseline = input.baselineStatus;
  const current = input.currentStatus;
  if (!baseline || !current) return [];

  const checkpointPaths = new Set(input.checkpointPaths);
  const metadataPaths = input.metadata.files?.length ? new Set(input.metadata.files) : undefined;
  const touchedPaths = new Set<string>();

  for (const mutation of input.mutations) {
    if (mutation.tool !== "bash") touchedPaths.add(mutation.path);
  }

  if (touchedPaths.size === 0 && input.mutations.some((mutation) => mutation.tool === "bash")) {
    for (const path of input.checkpointPaths) touchedPaths.add(path);
  }

  return Array.from(checkpointPaths)
    .filter((path) => !metadataPaths || metadataPaths.has(path))
    .filter((path) => touchedPaths.has(path))
    .filter((path) => !baseline.stagedPaths.has(path))
    .filter((path) => !baseline.unstagedPaths.has(path))
    .filter((path) => !baseline.untrackedPaths.has(path))
    .filter((path) => input.includeUntracked || !current.untrackedPaths.has(path));
}

function formatCommitMessage(input: {
  metadata: CommitMetadata;
  provider: string;
  workspaceId: string;
  toolCalls: number;
}): { subject: string; body: string } {
  const scope = input.metadata.scope ? `(${sanitizeScope(input.metadata.scope)})` : "";
  const subjectText = input.metadata.subject.replace(/^\w+(\([^)]*\))?:\s*/, "").trim();
  const subject = `${input.metadata.type}${scope}: ${subjectText}`.slice(0, 100);
  const trailers = [
    "DevSpace-Auto-Commit: true",
    `DevSpace-Commit-Provider: ${input.provider}`,
    ...(input.metadata.model ? [`DevSpace-Commit-Model: ${input.metadata.model}`] : []),
    `DevSpace-Tool-Calls: ${input.toolCalls}`,
    `DevSpace-Workspace: ${input.workspaceId}`,
  ];
  const bodySections = [input.metadata.body?.trim(), trailers.join("\n")].filter(Boolean);

  return {
    subject,
    body: bodySections.join("\n\n"),
  };
}

function sanitizeScope(scope: string): string {
  return scope.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 40);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
