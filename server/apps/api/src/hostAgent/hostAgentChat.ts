/**
 * Host "AI stand-in" replies: OpenAI-compatible chat via Hugging Face router (default) or OpenAI.
 * Same credentials pattern as agenda / translate.
 */

import { normalizeHfInferenceBaseUrl } from "../hf/normalizeHfInferenceBaseUrl";

const NOT_CONFIGURED = "HOST_AGENT_LLM_NOT_CONFIGURED"

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

async function runChatCompletion(opts: {
  url: string
  apiKey: string
  model: string
  system: string
  user: string
  maxTokens: number
}): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: 0.35,
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
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("Empty model response")
  }
  return content.trim()
}

export function isHostAgentLlmNotConfiguredError(e: unknown): boolean {
  return e instanceof Error && e.message.includes(NOT_CONFIGURED)
}

export async function runHostAgentChat(input: {
  hostDisplayName: string
  userMessage: string
  knowledgeBase: string
  meetingContext: string
}): Promise<{ reply: string; provider: "huggingface" | "openai" }> {
  const msg = input.userMessage.trim()
  if (!msg) {
    throw new Error("message is required")
  }

  const kb = input.knowledgeBase.trim()
  const ctx = input.meetingContext.trim()

  const system = `You are an AI assistant standing in for the meeting host (${input.hostDisplayName}).
You help answer questions about the meeting and the host's materials.
Rules:
- If a "Knowledge base" section is provided, treat it as the host's notes and documents. Prefer facts from it; if something is not there, say you do not have that in the provided materials.
- Use "Meeting context" (captions/transcript snippets) only as situational awareness; it may be incomplete or misheard.
- Be concise and speak as if addressing meeting participants (clear, professional).
- Do not claim legal, medical, or financial certainty. Do not invent policies or commitments on behalf of the host.`

  const userParts: string[] = []
  if (kb.length > 0) {
    userParts.push(`Knowledge base:\n${kb}`)
  } else {
    userParts.push("Knowledge base: (none provided)")
  }
  if (ctx.length > 0) {
    userParts.push(`Meeting context:\n${ctx}`)
  } else {
    userParts.push("Meeting context: (none provided)")
  }
  userParts.push(`Host request or question to answer:\n${msg}`)

  const user = userParts.join("\n\n")

  const hfToken =
    process.env.HUGGINGFACE_API_TOKEN?.trim() || process.env.HF_TOKEN?.trim()
  const openaiKey = process.env.OPENAI_API_KEY?.trim()

  if (hfToken) {
    const base = normalizeHfInferenceBaseUrl(process.env.HF_INFERENCE_BASE_URL)
    const model =
      process.env.HF_HOST_AGENT_MODEL?.trim() ||
      process.env.HF_AGENDA_MODEL?.trim() ||
      "google/gemma-2-2b-it"
    const url = chatCompletionsUrl(base)
    const reply = await runChatCompletion({
      url,
      apiKey: hfToken,
      model,
      system,
      user,
      maxTokens: 1200,
    })
    return { reply, provider: "huggingface" }
  }

  if (openaiKey) {
    const model =
      process.env.OPENAI_HOST_AGENT_MODEL?.trim() ||
      process.env.OPENAI_AGENDA_MODEL?.trim() ||
      "gpt-4o-mini"
    const reply = await runChatCompletion({
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: openaiKey,
      model,
      system,
      user,
      maxTokens: 1200,
    })
    return { reply, provider: "openai" }
  }

  throw new Error(
    `${NOT_CONFIGURED}: Set HUGGINGFACE_API_TOKEN (or HF_TOKEN) for free HF models, or OPENAI_API_KEY for OpenAI.`,
  )
}
