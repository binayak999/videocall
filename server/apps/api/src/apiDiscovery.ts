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
          body: { email: "string", password: "string" },
          responses: {
            200: { token: "string", user: "User" },
            401: { error: "string" },
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
          path: "/api/meetings/:code",
          auth: false,
          responses: {
            200: { meeting: "Meeting with host" },
            404: { error: "Meeting not found" },
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
    },
  };
}
