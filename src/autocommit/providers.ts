import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildCommitMetadataPrompt } from "./prompt.js";
import type {
  AutoCommitProvider,
  AutoCommitProviderId,
  CommitMetadata,
  GenerateCommitMetadataInput,
} from "./types.js";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const commitTypes = new Set([
  "feat",
  "fix",
  "refactor",
  "docs",
  "test",
  "chore",
  "style",
  "build",
  "perf",
  "ci",
]);

export interface CreateAutoCommitProvidersOptions {
  model?: string;
  codexReasoningEffort: string;
  codexFastMode: boolean;
}

export function createAutoCommitProvider(
  id: AutoCommitProviderId,
  options: CreateAutoCommitProvidersOptions,
): AutoCommitProvider {
  return id === "pi" ? createPiProvider(options) : createCodexProvider(options);
}

function createPiProvider(options: CreateAutoCommitProvidersOptions): AutoCommitProvider {
  return {
    id: "pi",
    async isAvailable() {
      try {
        await import("@earendil-works/pi-coding-agent");
        return { available: true };
      } catch (error) {
        return { available: false, reason: errorMessage(error) };
      }
    },
    async generateCommitMetadata(input) {
      const { AuthStorage, createAgentSession, ModelRegistry, SessionManager } = await import(
        "@earendil-works/pi-coding-agent"
      );
      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);
      const model = options.model ? resolvePiModel(modelRegistry, options.model) : undefined;
      const { session } = await createAgentSession({
        cwd: input.workspaceRoot,
        noTools: "all",
        sessionManager: SessionManager.inMemory(),
        authStorage,
        modelRegistry,
        ...(model ? { model } : {}),
      });
      let text = "";

      try {
        const unsubscribe = session.subscribe((event: unknown) => {
          const maybeEvent = event as {
            type?: string;
            assistantMessageEvent?: { type?: string; delta?: string };
          };
          if (
            maybeEvent.type === "message_update" &&
            maybeEvent.assistantMessageEvent?.type === "text_delta" &&
            typeof maybeEvent.assistantMessageEvent.delta === "string"
          ) {
            text += maybeEvent.assistantMessageEvent.delta;
          }
        });

        try {
          await session.prompt(providerPrompt(input), { expandPromptTemplates: false });
        } finally {
          unsubscribe();
        }

        return normalizeCommitMetadata(extractJsonObject(text));
      } finally {
        session.dispose();
      }
    },
  };
}

function resolvePiModel(
  modelRegistry: { find(provider: string, model: string): unknown },
  rawModel: string,
): CreateAgentSessionOptions["model"] {
  const separator = rawModel.indexOf("/");
  if (separator <= 0 || separator === rawModel.length - 1) {
    throw new Error("Pi autocommit model must use provider/model format.");
  }

  const provider = rawModel.slice(0, separator);
  const modelId = rawModel.slice(separator + 1);
  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`Pi autocommit model not found: ${rawModel}`);
  }

  return model as CreateAgentSessionOptions["model"];
}

function createCodexProvider(options: CreateAutoCommitProvidersOptions): AutoCommitProvider {
  return {
    id: "codex",
    async isAvailable() {
      try {
        await execFileAsync("codex", ["--version"], { maxBuffer: 1024 * 1024 });
        return { available: true };
      } catch (error) {
        return { available: false, reason: errorMessage(error) };
      }
    },
    async generateCommitMetadata(input) {
      const prompt = providerPrompt(input);
      const tempDir = await mkdtemp(join(tmpdir(), "devspace-autocommit-codex-"));
      const schemaPath = join(tempDir, "schema.json");
      const outputPath = join(tempDir, "output.json");

      try {
        await writeFile(schemaPath, JSON.stringify(commitMetadataJsonSchema(), null, 2));
        await writeFile(outputPath, "");

        await execFileAsync(
          "codex",
          [
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--model",
            options.model ?? "gpt-5.3-codex-spark",
            "--config",
            `model_reasoning_effort="${options.codexReasoningEffort}"`,
            ...(options.codexFastMode ? ["--config", `service_tier="fast"`] : []),
            "--output-schema",
            schemaPath,
            "--output-last-message",
            outputPath,
            prompt,
          ],
          {
            cwd: input.workspaceRoot,
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
            timeout: 180_000,
          },
        );

        return normalizeCommitMetadata(extractJsonObject(await readFile(outputPath, "utf8")));
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  };
}

function commitMetadataJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      shouldCommit: { type: "boolean" },
      type: { type: "string", enum: [...commitTypes] },
      scope: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
      files: { type: "array", items: { type: "string" } },
      reason: { type: "string" },
      model: { type: "string" },
    },
    required: ["shouldCommit", "type", "subject", "reason"],
  };
}

export async function generateWithProvider(
  provider: AutoCommitProvider,
  input: GenerateCommitMetadataInput,
): Promise<{ provider: AutoCommitProvider; metadata: CommitMetadata } | undefined> {
  const availability = await provider.isAvailable({ workspaceRoot: input.workspaceRoot });
  if (!availability.available) return undefined;

  try {
    const metadata = normalizeCommitMetadata(await provider.generateCommitMetadata(input));
    return { provider, metadata };
  } catch {
    return undefined;
  }
}

export function normalizeCommitMetadata(input: unknown): CommitMetadata {
  if (!input || typeof input !== "object") {
    throw new Error("Commit metadata must be an object.");
  }

  const metadata = input as Record<string, unknown>;
  const shouldCommit = metadata.shouldCommit === true;
  const rawType = typeof metadata.type === "string" ? metadata.type : "chore";
  const type = commitTypes.has(rawType) ? (rawType as CommitMetadata["type"]) : "chore";
  const subject = typeof metadata.subject === "string" ? metadata.subject.trim() : "";
  const reason = typeof metadata.reason === "string" ? metadata.reason.trim() : "";

  if (shouldCommit && subject.length === 0) {
    throw new Error("Commit metadata subject is required when shouldCommit is true.");
  }

  return {
    shouldCommit,
    type,
    scope: typeof metadata.scope === "string" && metadata.scope.trim() ? metadata.scope.trim() : undefined,
    subject: subject.slice(0, 100),
    body: typeof metadata.body === "string" && metadata.body.trim() ? metadata.body.trim() : undefined,
    files: Array.isArray(metadata.files)
      ? metadata.files.filter((file): file is string => typeof file === "string" && file.length > 0)
      : undefined,
    reason,
    model: typeof metadata.model === "string" && metadata.model.trim() ? metadata.model.trim() : undefined,
  };
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return JSON.parse(trimmed);

  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) return JSON.parse(match[1].trim());

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));

  throw new Error("Provider response did not contain JSON.");
}

export function providerPrompt(input: GenerateCommitMetadataInput): string {
  return buildCommitMetadataPrompt(input);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
