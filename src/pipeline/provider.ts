import type { ProviderName, Synthesizer } from "../types.js";
import { mockSynthesize } from "./mock.js";

/**
 * Picks the Stage 4 backend. This is the only place in the pipeline that knows
 * a paid API exists (docs/DESIGN.md §0.6).
 *
 * The Anthropic module is loaded lazily rather than imported at the top: in
 * mock mode the SDK is never even evaluated, so the free path cannot fail on a
 * missing key, a network hiccup, or an SDK change.
 */
export function createSynthesizer(provider: ProviderName, opts: { model: string }): Synthesizer {
  if (provider === "mock") return mockSynthesize;

  return async (input) => {
    const { synthesizeEvents } = await import("./synthesize.js");
    try {
      return await synthesizeEvents(input, { model: opts.model });
    } catch (err) {
      throw new Error(`${describeFailure(err)}\n원인: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/api[_ -]?key|authentication|credential|401/i.test(message)) {
    return (
      "Anthropic API 인증에 실패했습니다.\n" +
      "  · 키 설정:  PowerShell  $env:ANTHROPIC_API_KEY = \"sk-ant-...\"\n" +
      "  · 돈을 쓰지 않으려면 mock으로 되돌리세요:  --provider mock (기본값)"
    );
  }
  return "Stage 4(LLM 사건 합성) 호출에 실패했습니다.";
}
