/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  buildDraftCommandConfig,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
} from "@/provider-selection/provider-selection";
import { useAgentFormState } from "./use-agent-form-state";

const snapshot = vi.hoisted(() => ({ entries: [] as ProviderSnapshotEntry[] }));

vi.mock("./use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: snapshot.entries,
    isLoading: false,
    isRefreshing: false,
    error: null,
    refresh: vi.fn(),
    refetchIfStale: vi.fn(),
  }),
}));

vi.mock("./use-form-preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./use-form-preferences")>()),
  useFormPreferences: () => ({
    preferences: { provider: "codex" },
    isLoading: false,
    updatePreferences: async () => ({ provider: "codex" }),
  }),
}));

const model = (provider: string) => ({
  provider,
  id: "shared-model",
  label: "Shared model",
  isDefault: true,
  defaultThinkingOptionId: "medium",
  thinkingOptions: [
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ],
});

const entry = (
  provider: string,
  status: ProviderSnapshotEntry["status"],
  enabled = true,
): ProviderSnapshotEntry => ({
  provider,
  enabled,
  status,
  models: status === "ready" ? [model(provider)] : undefined,
  modes: [{ id: "full-access", label: "Full access" }],
  defaultModeId: "full-access",
});

const profile = {
  provider: "codex-astra-long",
  modelId: "shared-model",
  modeId: "full-access",
  thinkingOptionId: "medium",
  featureValues: {},
};

function creationConfig(form: ReturnType<typeof useAgentFormState>) {
  const selection = {
    provider: form.selectedProvider,
    modelId: form.selectedModel,
    modeId: form.selectedMode,
    thinkingOptionId: form.selectedThinkingOptionId,
    availableModels: form.availableModels,
    modeOptions: form.modeOptions,
  };
  const effectiveModelId = resolveEffectiveComposerModelId(selection);
  return buildDraftCommandConfig({
    selection,
    cwd: "/project",
    effectiveModelId,
    effectiveThinkingOptionId: resolveEffectiveComposerThinkingOptionId(
      selection,
      effectiveModelId,
    ),
  });
}

describe("useAgentFormState profile selection", () => {
  beforeEach(() => {
    snapshot.entries = [entry("codex", "ready"), entry("codex-astra-long", "loading")];
  });

  it("keeps a loading profile selection through readiness and uses its provider, model and High thinking for creation", () => {
    const { result, rerender } = renderHook(() =>
      useAgentFormState({ serverId: "host", workingDir: "/project" }),
    );
    expect(result.current.selectedProvider).toBe("codex");
    act(() => result.current.applyProfileFromUser(profile));
    expect(result.current.selectedProvider).toBe("codex-astra-long");
    expect(result.current.selectedModel).toBe("shared-model");

    snapshot.entries = [entry("codex", "ready"), entry("codex-astra-long", "ready")];
    rerender();
    act(() => result.current.setThinkingOptionFromUser("high"));
    expect(creationConfig(result.current)).toMatchObject({
      provider: "codex-astra-long",
      model: "shared-model",
      thinkingOptionId: "high",
    });
  });

  it("applies a ready profile and ignores disabled or failed providers", () => {
    snapshot.entries = [entry("codex", "ready"), entry("codex-astra-long", "ready")];
    const { result, rerender } = renderHook(() =>
      useAgentFormState({ serverId: "host", workingDir: "/project" }),
    );
    act(() => result.current.applyProfileFromUser(profile));
    expect(creationConfig(result.current)?.provider).toBe("codex-astra-long");

    act(() => result.current.setProviderAndModelFromUser("codex", "shared-model"));
    snapshot.entries = [entry("codex", "ready"), entry("codex-astra-long", "error")];
    rerender();
    act(() => result.current.applyProfileFromUser(profile));
    expect(creationConfig(result.current)?.provider).toBe("codex");

    snapshot.entries = [entry("codex", "ready"), entry("codex-astra-long", "loading", false)];
    rerender();
    act(() => result.current.applyProfileFromUser(profile));
    expect(creationConfig(result.current)?.provider).toBe("codex");
  });
});
