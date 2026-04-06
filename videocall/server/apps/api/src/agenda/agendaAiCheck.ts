import { normalizeHfInferenceBaseUrl } from "../hf/normalizeHfInferenceBaseUrl";

export type AgendaCheckItem = {
  label: string
  met: boolean
  confidence: "high" | "medium" | "low"
  reason: string
}

export type AgendaCheckResponse = {
  summary: string
  items: AgendaCheckItem[]
}

function stripJsonFence(s: string): string {
  let t = s.trim()
  if (t.startsWith("```")) {
    const lines = t.split("\n")
    if (lines.length >= 2) {
      t = lines.slice(1, -1).join("\n").trim()
      if (t.toLowerCase().startsWith("json")) {
        t = t.slice(4).trim()
      }
    }
  }
  return t
}

function isConfidence(v: unknown): v is AgendaCheckItem["confidence"] {
  return v === "high" || v === "medium" || v === "low"
}

export function parseAgendaCheckJson(raw: string): AgendaCheckResponse {
  const text = stripJsonFence(raw)
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid JSON from model")
  }
  const o = parsed as Record<string, unknown>
  const summary = typeof o.summary === "string" ? o.summary.trim() : ""
  const rawItems = o.items
  if (!Array.isArray(rawItems)) {
    throw new Error("Missing items array")
  }
  const items: AgendaCheckItem[] = []
  for (const row of rawItems) {
    if (!row || typeof row !== "object") continue
    const r = row as Record<string, unknown>
    const label = typeof r.label === "string" ? r.label.trim() : ""
    if (!label) continue
    const met = r.met === true
    const confidence = isConfidence(r.confidence) ? r.confidence : "medium"
    const reason = typeof r.reason === "string" ? r.reason.trim() : ""
    items.push({ label, met, confidence, reason })
  }
  return { summary: summary || "Analysis complete.", items }
}

const NOT_CONFIGURED = "AGENDA_AI_NOT_CONFIGURED"

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

async function runChatCompletionsAgendaCheck(
  agenda: string,
  transcript: string,
  opts: {
    url: string
    apiKey: string
    model: string
    /** OpenAI + many HF router models support json_object; omit if a model rejects it. */
    responseFormatJsonObject: boolean
  },
): Promise<AgendaCheckResponse> {
  const system = `You compare a meeting agenda to a spoken transcript (from speech-to-text; may be imperfect).
For each distinct agenda item or topic line, decide if the transcript provides clear evidence it was discussed or completed.
Be conservative: met=true only when the transcript reasonably shows that item was addressed.
Respond with JSON only using this shape:
{"summary":"one or two sentences overall","items":[{"label":"short agenda item text","met":true|false,"confidence":"high"|"medium"|"low","reason":"brief justification"}]}`

  const user = JSON.stringify({
    agenda,
    transcript,
  })

  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: 0.2,
    max_tokens: 2500,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  }
  if (opts.responseFormatJsonObject) {
    body.response_format = { type: "json_object" }
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
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("Empty model response")
  }

  return parseAgendaCheckJson(content)
}

/**
 * Uses Hugging Face Inference Providers (OpenAI-compatible) when `HUGGINGFACE_API_TOKEN` or `HF_TOKEN` is set.
 * Otherwise uses OpenAI when `OPENAI_API_KEY` is set.
 */
export async function runAgendaAiCheck(
  agenda: string,
  transcript: string,
): Promise<AgendaCheckResponse> {
  const hfToken =
    process.env.HUGGINGFACE_API_TOKEN?.trim() || process.env.HF_TOKEN?.trim()
  const openaiKey = process.env.OPENAI_API_KEY?.trim()

  if (hfToken) {
    const base = normalizeHfInferenceBaseUrl(process.env.HF_INFERENCE_BASE_URL)
    const model =
      process.env.HF_AGENDA_MODEL?.trim() || "google/gemma-2-2b-it"
    const url = chatCompletionsUrl(base)
    const wantJson = process.env.HF_AGENDA_JSON_MODE !== "0"
    if (wantJson) {
      try {
        return await runChatCompletionsAgendaCheck(agenda, transcript, {
          url,
          apiKey: hfToken,
          model,
          responseFormatJsonObject: true,
        })
      } catch (e: unknown) {
        const m = e instanceof Error ? e.message : String(e)
        if (!/response_format|json_object|json mode|does not support/i.test(m)) {
          throw e
        }
        // Some router models reject json_object; retry with prompt-only JSON.
      }
    }
    return runChatCompletionsAgendaCheck(agenda, transcript, {
      url,
      apiKey: hfToken,
      model,
      responseFormatJsonObject: false,
    })
  }

  if (openaiKey) {
    const model =
      process.env.OPENAI_AGENDA_MODEL?.trim() && process.env.OPENAI_AGENDA_MODEL.trim().length > 0
        ? process.env.OPENAI_AGENDA_MODEL.trim()
        : "gpt-4o-mini"
    return runChatCompletionsAgendaCheck(agenda, transcript, {
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: openaiKey,
      model,
      responseFormatJsonObject: true,
    })
  }

  throw new Error(`${NOT_CONFIGURED}: Set HUGGINGFACE_API_TOKEN (or HF_TOKEN) or OPENAI_API_KEY`)
}

export function isAgendaAiNotConfiguredError(e: unknown): boolean {
  return e instanceof Error && e.message.includes(NOT_CONFIGURED)
}
