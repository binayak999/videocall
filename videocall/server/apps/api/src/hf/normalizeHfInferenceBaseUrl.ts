/**
 * `https://api-inference.huggingface.co` is retired (410). Chat/translate must use the
 * OpenAI-compatible router base, e.g. `https://router.huggingface.co/v1` — model id goes in the
 * request body, not in the base URL.
 */
const ROUTER_CHAT_BASE = "https://router.huggingface.co/v1"

export function normalizeHfInferenceBaseUrl(envValue: string | undefined): string {
  const raw = envValue?.trim()
  if (!raw || raw.length === 0) {
    return ROUTER_CHAT_BASE
  }
  if (raw.includes("api-inference.huggingface.co")) {
    console.warn(
      "[HF] HF_INFERENCE_BASE_URL uses deprecated api-inference.huggingface.co; using https://router.huggingface.co/v1. Put the model id in HF_AGENDA_MODEL, HF_HOST_AGENT_MODEL, or HF_TRANSLATE_MODEL — not in the URL.",
    )
    return ROUTER_CHAT_BASE
  }
  return raw.replace(/\/+$/, "")
}
