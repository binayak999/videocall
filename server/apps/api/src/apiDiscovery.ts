import type { Request } from "express";

function publicBaseUrl(req: Request): string {
  const proto =
    req.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? req.protocol;
  const host = req.get("x-forwarded-host") ?? req.get("host") ?? "localhost";
  return `${proto}://${host}`;
}

function signalingUrls(): {
  /** URL the browser / native app should use for Socket.IO (set SIGNALING_PUBLIC_URL in prod). */
  clientUrl: string | null;
  /** Server-side health probe target (may differ from clientUrl). */
  serverProbeUrl: string | null;
} {
  const pub =
    process.env.SIGNALING_PUBLIC_URL !== undefined &&
    process.env.SIGNALING_PUBLIC_URL.length > 0
      ? process.env.SIGNALING_PUBLIC_URL.replace(/\/$/, "")
      : null;
  const internal =
    process.env.SIGNALING_URL !== undefined && process.env.SIGNALING_URL.length > 0
      ? process.env.SIGNALING_URL.replace(/\/$/, "")
      : null;
  return {
    clientUrl: pub ?? internal,
    serverProbeUrl: internal ?? pub,
  };
}

/** Human + machine-readable map of all HTTP and real-time surfaces for clients (React, React Native, etc.). */
export function buildApiManifest(req: Request): Record<string, unknown> {
  const base = publicBaseUrl(req);
  const { clientUrl, serverProbeUrl } = signalingUrls();

  return {
    name: "Nexivo",
    description:
      "REST API for auth and meetings; Socket.IO for WebRTC signaling (mesh, no SFU).",
    api: {
      baseUrl: base,
      health: `${base}/health`,
      signalingHealthProxy: `${base}/api/signaling-health`,
      openapi: `${base}/api/openapi.json`,
    },
    authentication: {
      type: "bearer-jwt",
      header: "Authorization: Bearer <token>",
      jwtPayload: { sub: "user id (cuid)" },
      expiresIn: "7d",
    },
    signaling: {
      transport: "socket.io",
      socketIo: {
        /** Connect to this URL; path defaults to /socket.io/ */
        url: clientUrl,
        auth: { token: "<same JWT as REST Bearer>" },
        maxPeersPerRoom: 20,
      },
      events: {
        clientToServer: [
          "meeting:join (code: string, ack)",
          "meeting:leave",
          "webrtc:offer",
          "webrtc:answer",
          "webrtc:ice",
        ],
        serverToClient: [
          "meeting:peer-joined",
          "meeting:peer-left",
          "webrtc:offer",
          "webrtc:answer",
          "webrtc:ice",
        ],
      },
      env: {
        SIGNALING_PUBLIC_URL:
          "Recommended in production: public wss/https URL for clients (e.g. https://meet.example.com:4002).",
        SIGNALING_URL:
          "Server-side URL used by API /api/signaling-health; defaults to loopback if unset.",
        note: serverProbeUrl !== null ? `Health probe target: ${serverProbeUrl}` : null,
      },
    },
    http: {
      endpoints: [
        {
          method: "GET",
          path: "/health",
          auth: false,
          description: "API process liveness",
          response: { status: "ok" },
        },
        {
          method: "GET",
          path: "/api/signaling-health",
          auth: false,
          description: "Proxies signaling /health for ops dashboards",
        },
        {
          method: "GET",
          path: "/api",
          auth: false,
          description: "This discovery document",
        },
        {
          method: "GET",
          path: "/api/openapi.json",
          auth: false,
          description: "OpenAPI 3 schema for REST routes",
        },
        {
          method: "POST",
          path: "/api/auth/register",
          auth: false,
          body: {
            email: "string",
            password: "string (min 8)",
            name: "string",
            recaptchaToken: "string | optional if RECAPTCHA_SECRET_KEY unset",
          },
          responses: {
            201: { token: "string", user: "User" },
            400: { error: "string" },
            409: { error: "Email already registered" },
          },
        },
        {
          method: "POST",
          path: "/api/auth/login",
          auth: false,
          body: {
            email: "string",
            password: "string",
            recaptchaToken: "string | optional if RECAPTCHA_SECRET_KEY unset",
          },
          responses: {
            200: { token: "string", user: "User" },
            401: { error: "string" },
          },
        },
        {
          method: "POST",
          path: "/api/auth/google",
          auth: false,
          description:
            "Google Identity Services ID token; creates or links user by verified email. Requires GOOGLE_CLIENT_ID.",
          body: {
            idToken: "string (Google JWT credential)",
            recaptchaToken: "string | optional if RECAPTCHA_SECRET_KEY unset",
          },
          responses: {
            200: { token: "string", user: "User" },
            400: { error: "string" },
            401: { error: "Invalid Google token" },
            403: { error: "Google email is not verified" },
            409: { error: "Account conflict" },
            503: { error: "Google sign-in is not configured" },
          },
        },
        {
          method: "POST",
          path: "/api/meetings",
          auth: "Bearer JWT",
          body: { title: "string | optional" },
          responses: {
            201: { meeting: "Meeting with host" },
            401: { error: "string" },
          },
        },
        {
          method: "GET",
          path: "/api/meetings/:code/captions",
          auth: "Bearer JWT",
          description: "Host only: saved live-caption transcript lines for the meeting.",
          responses: {
            200: { captions: "MeetingCaptionRow[]" },
            403: { error: "Only the meeting host can download captions" },
            404: { error: "Meeting not found" },
          },
        },
        {
          method: "GET",
          path: "/api/meetings/:code/polls",
          auth: "Bearer JWT",
          description:
            "Host only: saved 👍/👎 polls for the meeting; anonymous polls omit per-voter list in JSON.",
          responses: {
            200: { polls: "MeetingPollSaved[]" },
            403: { error: "Only the meeting host can view saved polls" },
            404: { error: "Meeting not found" },
          },
        },
        {
          method: "GET",
          path: "/api/meetings/:code",
          auth: false,
          responses: {
            200: { meeting: "Meeting with host" },
            404: { error: "Meeting not found" },
          },
        },
        {
          method: "POST",
          path: "/api/meetings/:code/agenda/analyze",
          auth: "Bearer JWT",
          description:
            "Host only: compares agenda + transcript via AI. Prefer HUGGINGFACE_API_TOKEN (router) or OPENAI_API_KEY.",
          body: { agenda: "string", transcript: "string" },
          responses: {
            200: { summary: "string", items: "AgendaCheckItem[]" },
            403: { error: "Only the meeting host can analyze the agenda" },
            503: { error: "AI not configured (HF token or OpenAI key)" },
          },
        },
        {
          method: "POST",
          path: "/api/meetings/:code/host-agent/chat",
          auth: "Bearer JWT",
          description:
            "Host only: RAG-style reply using knowledgeBase + meetingContext + message. LLM: HF router (default) or OpenAI.",
          body: {
            message: "string",
            knowledgeBase: "string | optional",
            meetingContext: "string | optional",
          },
          responses: {
            200: { reply: "string", provider: "huggingface | openai" },
            403: { error: "Only the meeting host can use the host agent" },
            503: { error: "Host agent LLM not configured" },
          },
        },
        {
          method: "POST",
          path: "/api/meetings/:code/host-agent/transcribe",
          auth: "Bearer JWT",
          description:
            "Host only: raw audio body (Content-Type = audio mime). STT: Hugging Face Whisper by default; HOST_AGENT_STT_PROVIDER=openai uses OpenAI.",
          body: "binary (not JSON)",
          responses: {
            200: { text: "string", provider: "huggingface | openai" },
            403: { error: "Only the meeting host can transcribe" },
            503: { error: "STT not configured" },
          },
        },
        {
          method: "POST",
          path: "/api/translate",
          auth: "Bearer JWT",
          description:
            "Translate text (same AI credentials as agenda: HF router or OpenAI). Optional sourceLanguage hint.",
          body: {
            text: "string",
            targetLanguage: "string (e.g. English (United States))",
            sourceLanguage: "string | optional",
          },
          responses: {
            200: { translated: "string" },
            401: { error: "string" },
            503: { error: "AI not configured" },
            502: { error: "Translation failed" },
          },
        },
      ],
    },
    models: {
      User: {
        id: "string",
        email: "string",
        name: "string",
        createdAt: "ISO8601",
      },
      Meeting: {
        id: "string",
        code: "string",
        hostId: "string",
        title: "string | null",
        createdAt: "ISO8601",
        endsAt: "ISO8601 | null",
        host: "User (subset)",
      },
    },
  };
}

export function buildOpenApi(req: Request): Record<string, unknown> {
  const base = publicBaseUrl(req);
  return {
    openapi: "3.0.3",
    info: {
      title: "Nexivo API",
      version: "0.0.0",
      description:
        "Authentication and meetings REST API. Real-time WebRTC signaling uses Socket.IO (see GET /api manifest).",
    },
    servers: [{ url: base, description: "Current request origin" }],
    tags: [
      { name: "Health", description: "Liveness and upstream checks" },
      { name: "Auth", description: "Register and login" },
      { name: "Meetings", description: "Create and resolve meetings by code" },
      { name: "Translate", description: "Authenticated text translation (shared AI backend)" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "string" } },
          required: ["error"],
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string" },
            email: { type: "string", format: "email" },
            name: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
          required: ["id", "email", "name", "createdAt"],
        },
        Meeting: {
          type: "object",
          properties: {
            id: { type: "string" },
            code: { type: "string" },
            hostId: { type: "string" },
            title: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
            endsAt: { type: "string", format: "date-time", nullable: true },
            host: { $ref: "#/components/schemas/User" },
          },
          required: ["id", "code", "hostId", "createdAt", "host"],
        },
        AuthResponse: {
          type: "object",
          properties: {
            token: { type: "string" },
            user: { $ref: "#/components/schemas/User" },
          },
          required: ["token", "user"],
        },
        MeetingResponse: {
          type: "object",
          properties: {
            meeting: { $ref: "#/components/schemas/Meeting" },
          },
          required: ["meeting"],
        },
      },
    },
    paths: {
      "/health": {
        get: {
          tags: ["Health"],
          summary: "API health",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { status: { type: "string", example: "ok" } },
                  },
                },
              },
            },
          },
        },
      },
      "/api/signaling-health": {
        get: {
          tags: ["Health"],
          summary: "Signaling service health (proxied)",
          responses: {
            "200": { description: "Signaling reachable" },
            "502": { description: "Signaling unreachable" },
          },
        },
      },
      "/api/auth/register": {
        post: {
          tags: ["Auth"],
          summary: "Register",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password", "name"],
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string", minLength: 8 },
                    name: { type: "string" },
                    recaptchaToken: { type: "string", description: "reCAPTCHA v3 token (required when API has RECAPTCHA_SECRET_KEY)" },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/AuthResponse" },
                },
              },
            },
            "400": {
              description: "Validation error",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "409": {
              description: "Email already registered",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/api/auth/login": {
        post: {
          tags: ["Auth"],
          summary: "Login",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password"],
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string" },
                    recaptchaToken: { type: "string", description: "reCAPTCHA v3 token (required when API has RECAPTCHA_SECRET_KEY)" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/AuthResponse" },
                },
              },
            },
            "401": {
              description: "Invalid credentials",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/api/auth/google": {
        post: {
          tags: ["Auth"],
          summary: "Sign in with Google (ID token)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["idToken"],
                  properties: {
                    idToken: { type: "string", description: "Credential JWT from Google Identity Services" },
                    recaptchaToken: { type: "string", description: "reCAPTCHA v3 token (required when API has RECAPTCHA_SECRET_KEY)" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/AuthResponse" },
                },
              },
            },
            "400": {
              description: "Bad request",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "401": {
              description: "Invalid Google token",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "403": {
              description: "Google email not verified",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "409": {
              description: "Account conflict",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "503": {
              description: "Google OAuth client id not configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/api/meetings": {
        post: {
          tags: ["Meetings"],
          summary: "Create meeting",
          security: [{ bearerAuth: [] }],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/MeetingResponse" },
                },
              },
            },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/api/meetings/{code}/captions": {
        get: {
          tags: ["Meetings"],
          summary: "List saved live captions (host only)",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "code",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["captions"],
                    properties: {
                      captions: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["id", "speakerUserId", "speakerName", "text", "createdAt"],
                          properties: {
                            id: { type: "string" },
                            speakerUserId: { type: "string" },
                            speakerName: { type: "string" },
                            text: { type: "string" },
                            createdAt: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "403": {
              description: "Not the meeting host",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "404": {
              description: "Not found",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/api/meetings/{code}/polls": {
        get: {
          tags: ["Meetings"],
          summary: "List saved meeting polls (host only)",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "code",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["polls"],
                    properties: {
                      polls: {
                        type: "array",
                        items: { type: "object" },
                      },
                    },
                  },
                },
              },
            },
            "403": {
              description: "Not the meeting host",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "404": {
              description: "Not found",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/api/meetings/{code}": {
        get: {
          tags: ["Meetings"],
          summary: "Get meeting by code",
          parameters: [
            {
              name: "code",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/MeetingResponse" },
                },
              },
            },
            "404": {
              description: "Not found",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/api/meetings/{code}/agenda/analyze": {
        post: {
          tags: ["Meetings"],
          summary: "Analyze agenda vs transcript (host only, HF or OpenAI)",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "code",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["agenda", "transcript"],
                  properties: {
                    agenda: { type: "string" },
                    transcript: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Structured checklist from model",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["summary", "items"],
                    properties: {
                      summary: { type: "string" },
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["label", "met", "confidence", "reason"],
                          properties: {
                            label: { type: "string" },
                            met: { type: "boolean" },
                            confidence: {
                              type: "string",
                              enum: ["high", "medium", "low"],
                            },
                            reason: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "403": {
              description: "Not the meeting host",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "503": {
              description: "No Hugging Face or OpenAI API key configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/api/meetings/{code}/host-agent/chat": {
        post: {
          tags: ["Meetings"],
          summary: "Host agent chat (HF router or OpenAI)",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "code",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["message"],
                  properties: {
                    message: { type: "string" },
                    knowledgeBase: { type: "string" },
                    meetingContext: { type: "string" },
                    duoHostMode: { type: "boolean" },
                    autopilotFast: {
                      type: "boolean",
                      description:
                        "When true, uses lower max_tokens and a tighter prompt for faster in-call autopilot replies.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Model reply",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["reply", "provider"],
                    properties: {
                      reply: { type: "string" },
                      provider: { type: "string", enum: ["huggingface", "openai"] },
                    },
                  },
                },
              },
            },
            "403": {
              description: "Not the meeting host",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "503": {
              description: "LLM not configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/api/meetings/{code}/host-agent/transcribe": {
        post: {
          tags: ["Meetings"],
          summary: "Host agent audio transcription (HF Whisper or OpenAI)",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "code",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "audio/wav": { schema: { type: "string", format: "binary" } },
              "audio/webm": { schema: { type: "string", format: "binary" } },
              "audio/mp4": { schema: { type: "string", format: "binary" } },
            },
          },
          responses: {
            "200": {
              description: "Transcript text",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["text", "provider"],
                    properties: {
                      text: { type: "string" },
                      provider: { type: "string", enum: ["huggingface", "openai"] },
                    },
                  },
                },
              },
            },
            "403": {
              description: "Not the meeting host",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "503": {
              description: "STT not configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/api/translate": {
        post: {
          tags: ["Translate"],
          summary: "Translate text (HF or OpenAI)",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["text", "targetLanguage"],
                  properties: {
                    text: { type: "string" },
                    targetLanguage: { type: "string" },
                    sourceLanguage: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["translated"],
                    properties: { translated: { type: "string" } },
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "503": {
              description: "AI not configured",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "502": {
              description: "Upstream translation error",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
    },
  };
}
