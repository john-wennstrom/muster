import { renderPrompt, type RenderedPrompt } from "../../src/prompts/render.ts";

/** A rendered prompt carrying `text`, for tests that need an agent prompt but not a particular one. */
export function promptFor(text: string): RenderedPrompt {
  return renderPrompt("explore", { USER_REQUEST: text, AUTHORITATIVE_CONTEXT_BLOCK: "", SUPPLEMENTAL_FACTS_BLOCK: "" });
}
