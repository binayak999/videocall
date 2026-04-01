/**
 * Speech-to-text for the host agent.
 * Default: Hugging Face Inference (Whisper) via router — free tier friendly (`openai/whisper-base`).
 * Optional: OpenAI `whisper-1` when HOST_AGENT_STT_PROVIDER=openai (premium path).
 */

const NOT_CONFIGURED_HF = "HOST_AGENT_STT_NOT_CONFIGURED_HF"

function hfAsrUrl(model: string): string {
  const m = model.trim().replace(/^\/+/, "")
  return `https://router.huggingface.co/hf-inference/models/${m}`
}

function parseAsrResponse(data: unknown): string {
  if (typeof data === "string") {
    const t = data.trim()
    if (t.length > 0) return t
  }
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0]
    if (first && typeof first === "object" && "text" in first) {
      const tx = (first as { text?: unknown }).text
      if (typeof tx === "string" && tx.trim().length > 0) return tx.trim()
    }
  }
  if (data && typeof data === "object" && "text" in data) {
    const tx = (data as { text?: unknown }).text
    if (typeof tx === "string") return tx.trim()
  }
  throw new Error("Unexpected speech-to-text response shape from provider")
}

function errorFromHfBody(data: unknown, fallback: string): string {
  if (typeof data === "object" && data !== null) {
    const o = data as Record<string, unknown>
    const err = o.error
    if (typeof err === "string" && err.length > 0) return err
    if (err && typeof err === "object") {
      const em = (err as { message?: unknown }).message
      if (typeof em === "string" && em.length > 0) return em
    }
  }
  return fallback
}

async function transcribeHuggingFace(audio: Buffer, contentType: string): Promise<string> {
  const token =
    process.env.HUGGINGFACE_API_TOKEN?.trim() || process.env.HF_TOKEN?.trim()
  if (!token) {
    throw new Error(
      `${NOT_CONFIGURED_HF}: Set HUGGINGFACE_API_TOKEN or HF_TOKEN for Hugging Face Whisper.`,
    )
  }

  const model =
    process.env.HF_STT_MODEL?.trim() && process.env.HF_STT_MODEL.trim().length > 0
      ? process.env.HF_STT_MODEL.trim()
      : "openai/whisper-base"

  const url = hfAsrUrl(model)
  const ct =
    contentType.trim().length > 0 ? contentType.split(";")[0]!.trim() : "application/octet-stream"

  const maxAttempts = 2
  let lastErr = "STT request failed"

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": ct,
      },
      body: audio,
    })

    const rawText = await res.text()
    let data: unknown = null
    if (rawText.length > 0) {
      try {
        data = JSON.parse(rawText) as unknown
      } catch {
        data = { raw: rawText }
      }
    }

    if (res.ok) {
      return parseAsrResponse(data)
    }

    lastErr = errorFromHfBody(data, `HTTP ${res.status}`)
    const loading =
      res.status === 503 ||
      /loading|unavailable|warm|cold|starting/i.test(lastErr) ||
      (typeof data === "object" &&
        data !== null &&
        "estimated_time" in data)
    if (loading && attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, 2500))
      continue
    }
    throw new Error(lastErr)
  }

  throw new Error(lastErr)
}

async function transcribeOpenAI(audio: Buffer, contentType: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) {
    throw new Error("OPENAI_API_KEY is required when HOST_AGENT_STT_PROVIDER=openai")
  }

  const ct =
    contentType.trim().length > 0 ? contentType.split(";")[0]!.trim() : "application/octet-stream"
  const ext =
    ct.includes("wav") ? "wav" : ct.includes("mp3") ? "mp3" : ct.includes("mpeg") ? "mp3" : "webm"

  const blob = new Blob([new Uint8Array(audio)], { type: ct })
  const form = new FormData()
  form.append("file", blob, `audio.${ext}`)
  form.append("model", "whisper-1")

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
    },
    body: form,
  })

  const data = (await res.json()) as unknown
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error?: { message?: string } }).error?.message ?? res.status)
        : `HTTP ${res.status}`
    throw new Error(msg)
  }

  if (data && typeof data === "object" && "text" in data) {
    const t = (data as { text?: unknown }).text
    if (typeof t === "string") return t.trim()
  }
  throw new Error("Empty OpenAI transcription")
}

export function isHostAgentSttNotConfiguredHfError(e: unknown): boolean {
  return e instanceof Error && e.message.includes(NOT_CONFIGURED_HF)
}

/**
 * Transcribe raw audio bytes. Provider selected by HOST_AGENT_STT_PROVIDER (default huggingface).
 */
export async function transcribeHostAgentAudio(
  audio: Buffer,
  contentType: string,
): Promise<{ text: string; provider: "huggingface" | "openai" }> {
  const provider = (process.env.HOST_AGENT_STT_PROVIDER ?? "huggingface").trim().toLowerCase()
  if (provider === "openai") {
    const text = await transcribeOpenAI(audio, contentType)
    return { text, provider: "openai" }
  }
  const text = await transcribeHuggingFace(audio, contentType)
  return { text, provider: "huggingface" }
}
