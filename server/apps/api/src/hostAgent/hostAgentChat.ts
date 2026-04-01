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

type ChatTurn = { role: "user" | "assistant"; content: string }

async function runChatCompletion(opts: {
  url: string
  apiKey: string
  model: string
  system: string
  priorMessages: ChatTurn[]
  userMessage: string
  maxTokens: number
}): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: opts.system },
    ...opts.priorMessages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: opts.userMessage },
  ]

  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: 0.35,
    max_tokens: opts.maxTokens,
    messages,
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

function buildHostAgentSystem(input: {
  hostDisplayName: string
  knowledgeBase: string
  meetingContext: string
  duoHostMode: boolean
}): string {
  const kb = input.knowledgeBase.trim()
  const ctx = input.meetingContext.trim()
  const kbBlock =
    kb.length > 0 ? `Knowledge base:\n${kb}` : "Knowledge base: (none provided)"
  const ctxBlock =
    ctx.length > 0 ? `Meeting context (captions / notes; may be partial):\n${ctx}` : "Meeting context: (none provided)"

  const duoBlock = input.duoHostMode
    ? `
Duo / 1:1 mode: Only the host (you) and one participant are in this call. Respond like a capable human host: acknowledge what they say, keep the conversation moving, answer questions, offer concise follow-ups, and handle brief or informal utterances—not only explicit questions. Skip responding only to pure filler ("mm", "uh-huh") with nothing to act on.`
    : ""

  return `You are an AI assistant standing in for the meeting host (${input.hostDisplayName}).
You help participants using the host's materials and the conversation so far.
${duoBlock}

${kbBlock}

${ctxBlock}

Rules:
- Use the prior conversation turns for continuity; the latest user message is what you must address now.
- Answer ONLY what the latest message calls for. Do NOT dump or summarize the entire knowledge base unless they ask.
- Keep replies short and spoken: usually 2–4 sentences; in duo mode you may stretch slightly when guiding the conversation. At most 3 bullets if lists help.
- If the knowledge base has relevant facts, use them. If not, you may use general knowledge but say so, and ask one clarifying question if needed (except in duo mode for casual back-and-forth, where a light acknowledgment is enough).
- Meeting context may be incomplete or misheard—treat it as hints only.
- Do not invent policies, dates, numbers, or commitments for the host.
${input.duoHostMode ? "- In duo mode, prefer helpful continuity over interrogating with clarifying questions." : "- If the latest message is ambiguous, ask one clarifying question instead of guessing."}`
}

export function isHostAgentLlmNotConfiguredError(e: unknown): boolean {
  return e instanceof Error && e.message.includes(NOT_CONFIGURED)
}

export async function runHostAgentChat(input: {
  hostDisplayName: string
  userMessage: string
  knowledgeBase: string
  meetingContext: string
  conversationHistory?: ChatTurn[]
  duoHostMode?: boolean
}): Promise<{ reply: string; provider: "huggingface" | "openai" }> {
  const msg = input.userMessage.trim()
  if (!msg) {
    throw new Error("message is required")
  }

  const kb = input.knowledgeBase.trim()
  const ctx = input.meetingContext.trim()
  const duoHostMode = Boolean(input.duoHostMode)
  const priorMessages = Array.isArray(input.conversationHistory) ? input.conversationHistory : []

  const system = buildHostAgentSystem({
    hostDisplayName: input.hostDisplayName,
    knowledgeBase: kb,
    meetingContext: ctx,
    duoHostMode,
  })

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
      priorMessages,
      userMessage: msg,
      maxTokens: duoHostMode ? 420 : 320,
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
      priorMessages,
      userMessage: msg,
      maxTokens: duoHostMode ? 420 : 320,
    })
    return { reply, provider: "openai" }
  }

  throw new Error(
    `${NOT_CONFIGURED}: Set HUGGINGFACE_API_TOKEN (or HF_TOKEN) for free HF models, or OPENAI_API_KEY for OpenAI.`,
  )
}
