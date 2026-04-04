import { normalizeHfInferenceBaseUrl } from "../hf/normalizeHfInferenceBaseUrl";

const NOT_CONFIGURED = "TRANSLATE_AI_NOT_CONFIGURED"

function chatCompletionsUrl(base: string): string {
  const b = base.replace(/\/+$/, "")
  return `${b}/chat/completions`
}

function errorMessageFromProviderBody(data: unknown, fallback: string): string {
  if (typeof data === "object" && data !== null) {
    const o = data as Record<string, unknown>
    const err = o.error
    if (typeof err === "string" && err.length > 0) return err
    if (err && typeof err === "object") {
      const em = (err as { message?: unknown }).message
      if (typeof em === "string" && em.length > 0) return em
    }
    const msg = o.message
    if (typeof msg === "string" && msg.length > 0) return msg
  }
  return fallback
}

async function runChatCompletionText(opts: {
  url: string
  apiKey: string
  model: string
  system: string
  user: string
  maxTokens: number
}): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: 0.2,
    max_tokens: opts.maxTokens,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  }

  const res = await fetch(opts.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
  })

  const data = (await res.json()) as unknown
  if (!res.ok) {
    const msg = errorMessageFromProviderBody(data, `HTTP ${res.status}`)
    throw new Error(msg)
  }

  const d = data as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = d.choices?.[0]?.message?.content
  if (typeof content !== "string") {
    throw new Error("Empty model response")
  }
  return content.trim()
}

/**
 * Same credentials as agenda AI: HF router first, then OpenAI.
 */
export async function runTranslateText(
  text: string,
  targetLanguage: string,
  sourceLanguage?: string,
): Promise<string> {
  const target = targetLanguage.trim()
  if (!target) {
    throw new Error("targetLanguage is required")
  }

  const sourceHint =
    sourceLanguage !== undefined && sourceLanguage.trim().length > 0
      ? `The source text is mostly in: ${sourceLanguage.trim()}.`
      : "Infer the source language from the text."

  const system = `You are a professional translator. ${sourceHint}
Translate the user's text into ${target}. Preserve paragraph breaks and bullet structure when obvious.
Output only the translation — no quotes, no "Here is the translation" preamble.`

  const user = text

  const hfToken =
    process.env.HUGGINGFACE_API_TOKEN?.trim() || process.env.HF_TOKEN?.trim()
  const openaiKey = process.env.OPENAI_API_KEY?.trim()

  if (hfToken) {
    const base = normalizeHfInferenceBaseUrl(process.env.HF_INFERENCE_BASE_URL)
    const model =
      process.env.HF_TRANSLATE_MODEL?.trim() ||
      process.env.HF_AGENDA_MODEL?.trim() ||
      "google/gemma-2-2b-it"
    const out = await runChatCompletionText({
      url: chatCompletionsUrl(base),
      apiKey: hfToken,
      model,
      system,
      user,
      maxTokens: Math.min(4096, Math.max(256, Math.ceil(text.length / 2) + 400)),
    })
    return out
  }

  if (openaiKey) {
    const model =
      process.env.OPENAI_TRANSLATE_MODEL?.trim() ||
      process.env.OPENAI_AGENDA_MODEL?.trim() ||
      "gpt-4o-mini"
    const out = await runChatCompletionText({
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: openaiKey,
      model,
      system,
      user,
      maxTokens: Math.min(4096, Math.max(256, Math.ceil(text.length / 2) + 400)),
    })
    return out
  }

  throw new Error(`${NOT_CONFIGURED}: Set HUGGINGFACE_API_TOKEN (or HF_TOKEN) or OPENAI_API_KEY`)
}

export function isTranslateAiNotConfiguredError(e: unknown): boolean {
  return e instanceof Error && e.message.includes(NOT_CONFIGURED)
}
