import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Log } from "../util/log"
import { OAUTH_DUMMY_KEY } from "../auth"

const log = Log.create({ service: "plugin.gemini-cli" })

// Gemini CLI OAuth credentials (from gemini-cli source)
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/oauth2.ts
const OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"
const OAUTH_CLIENT_SECRET = "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"

// OAuth endpoints
const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"

// Code Assist API endpoint
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com"
const CODE_ASSIST_API_VERSION = "v1internal"

// OAuth scopes required for Gemini CLI
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]

const OAUTH_PORT = 1456

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43)
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("")
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES.join(" "),
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state,
  })
  return `${OAUTH_AUTH_URL}?${params.toString()}`
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in?: number
  token_type: string
  scope?: string
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Token exchange failed: ${response.status} - ${errorText}`)
  }
  return response.json()
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    }).toString(),
  })
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Token refresh failed: ${response.status} - ${errorText}`)
  }
  return response.json()
}

// User setup types
interface LoadCodeAssistResponse {
  currentTier?: { id: string }
  allowedTiers?: Array<{ id: string }>
  cloudaicompanionProject?: string
}

interface OnboardUserResponse {
  name?: string
  done?: boolean
  response?: {
    cloudaicompanionProject?: { id: string }
  }
}

interface LROResult {
  done?: boolean
  response?: {
    cloudaicompanionProject?: { id: string }
  }
}

async function callLoadCodeAssist(
  accessToken: string,
  envProject?: string,
): Promise<LoadCodeAssistResponse> {
  const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:loadCodeAssist`

  const metadata = {
    ideType: "cli",
    ideVersion: "opencode",
    clientType: "CLOUD_CODE",
    pluginType: "GEMINI_CLI",
  }

  const body: Record<string, unknown> = { metadata }
  if (envProject) {
    body.cloudaicompanionProject = `projects/${envProject}`
    body.duetProject = `projects/${envProject}`
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    log.error("loadCodeAssist failed", { status: response.status, error: errorText })
    throw new Error(`loadCodeAssist failed: ${response.status}`)
  }

  return response.json()
}

async function callOnboardUser(accessToken: string, tierId: string): Promise<OnboardUserResponse> {
  const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:onboardUser`

  const metadata = {
    ideType: "cli",
    ideVersion: "opencode",
    clientType: "CLOUD_CODE",
    pluginType: "GEMINI_CLI",
  }

  const body = {
    tierId,
    metadata,
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    log.error("onboardUser failed", { status: response.status, error: errorText })
    throw new Error(`onboardUser failed: ${response.status}`)
  }

  return response.json()
}

async function pollLRO(accessToken: string, operationName: string): Promise<LROResult> {
  const maxAttempts = 60 // 5 minutes with 5 second intervals
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}/${operationName}`

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })

    if (!response.ok) {
      throw new Error(`LRO poll failed: ${response.status}`)
    }

    const result: LROResult = await response.json()
    if (result.done) {
      return result
    }

    await new Promise((resolve) => setTimeout(resolve, 5000))
  }

  throw new Error("LRO polling timeout")
}

async function setupGeminiUser(accessToken: string): Promise<{ projectId: string; userTier?: string }> {
  const envProject = process.env.GOOGLE_CLOUD_PROJECT

  // Step 1: Try loadCodeAssist to check if user is already set up
  const loadResult = await callLoadCodeAssist(accessToken, envProject)

  if (loadResult.currentTier || loadResult.cloudaicompanionProject) {
    const projectId = loadResult.cloudaicompanionProject?.replace("projects/", "") || envProject
    if (!projectId) {
      throw new Error("No project ID returned from loadCodeAssist")
    }
    log.info("user already setup", { projectId, tier: loadResult.currentTier?.id })
    return { projectId, userTier: loadResult.currentTier?.id }
  }

  // Step 2: User needs onboarding - use free tier by default
  const tierId = loadResult.allowedTiers?.[0]?.id || "free-tier"
  log.info("onboarding user", { tierId })

  const onboardResult = await callOnboardUser(accessToken, tierId)

  // Step 3: Poll LRO if needed
  if (onboardResult.name && !onboardResult.done) {
    log.info("polling LRO", { operationName: onboardResult.name })
    const lroResult = await pollLRO(accessToken, onboardResult.name)
    const projectId = lroResult.response?.cloudaicompanionProject?.id
    if (!projectId) {
      throw new Error("No project ID returned from onboarding LRO")
    }
    return { projectId, userTier: tierId }
  }

  const projectId = onboardResult.response?.cloudaicompanionProject?.id
  if (!projectId) {
    throw new Error("No project ID returned from onboarding")
  }
  return { projectId, userTier: tierId }
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>OpenCode - Gemini Authorization Successful</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #f1ecec;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to OpenCode.</p>
    </div>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`

const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <title>OpenCode - Gemini Authorization Failed</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #fc533a;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
      .error {
        color: #ff917b;
        font-family: monospace;
        margin-top: 1rem;
        padding: 1rem;
        background: #3c140d;
        border-radius: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">${error}</div>
    </div>
  </body>
</html>`

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof Bun.serve> | undefined
let pendingOAuth: PendingOAuth | undefined

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  }

  oauthServer = Bun.serve({
    port: OAUTH_PORT,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/auth/callback") {
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        const error = url.searchParams.get("error")
        const errorDescription = url.searchParams.get("error_description")

        if (error) {
          const errorMsg = errorDescription || error
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!code) {
          const errorMsg = "Missing authorization code"
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!pendingOAuth || state !== pendingOAuth.state) {
          const errorMsg = "Invalid state - potential CSRF attack"
          pendingOAuth?.reject(new Error(errorMsg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        const current = pendingOAuth
        pendingOAuth = undefined

        exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce)
          .then((tokens) => current.resolve(tokens))
          .catch((err) => current.reject(err))

        return new Response(HTML_SUCCESS, {
          headers: { "Content-Type": "text/html" },
        })
      }

      if (url.pathname === "/cancel") {
        pendingOAuth?.reject(new Error("Login cancelled"))
        pendingOAuth = undefined
        return new Response("Login cancelled", { status: 200 })
      }

      return new Response("Not found", { status: 404 })
    },
  })

  log.info("gemini-cli oauth server started", { port: OAUTH_PORT })
  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.stop()
    oauthServer = undefined
    log.info("gemini-cli oauth server stopped")
  }
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingOAuth) {
          pendingOAuth = undefined
          reject(new Error("OAuth callback timeout - authorization took too long"))
        }
      },
      5 * 60 * 1000, // 5 minute timeout
    )

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
}

// Cache for user project setup
let cachedUserSetup: { projectId: string; userTier?: string } | undefined

export async function GeminiCliAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "google",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // Filter models to only Gemini models for OAuth
        const allowedModelPrefixes = ["gemini-"]
        for (const modelId of Object.keys(provider.models)) {
          const isAllowed = allowedModelPrefixes.some((prefix) => modelId.startsWith(prefix))
          if (!isAllowed) {
            delete provider.models[modelId]
          }
        }

        // Zero out costs for Gemini CLI (included with Google subscription)
        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          }
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            // Remove dummy API key authorization header
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization")
                init.headers.delete("Authorization")
                init.headers.delete("x-goog-api-key")
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([key]) => !["authorization", "x-goog-api-key"].includes(key.toLowerCase()),
                )
              } else {
                delete init.headers["authorization"]
                delete init.headers["Authorization"]
                delete init.headers["x-goog-api-key"]
              }
            }

            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            // Check if token needs refresh
            if (!currentAuth.access || currentAuth.expires < Date.now()) {
              log.info("refreshing gemini-cli access token")
              const tokens = await refreshAccessToken(currentAuth.refresh)
              await input.client.auth.set({
                path: { id: "google" },
                body: {
                  type: "oauth",
                  refresh: tokens.refresh_token || currentAuth.refresh,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                },
              })
              currentAuth.access = tokens.access_token
            }

            // Setup user if not already done
            if (!cachedUserSetup) {
              try {
                cachedUserSetup = await setupGeminiUser(currentAuth.access)
                log.info("gemini user setup complete", { projectId: cachedUserSetup.projectId })
              } catch (error) {
                log.error("gemini user setup failed", { error })
                throw error
              }
            }

            // Parse the original URL and body to transform the request
            const parsed =
              requestInput instanceof URL
                ? requestInput
                : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)

            // Check if this is a Gemini API request
            const isGeminiRequest =
              parsed.hostname.includes("generativelanguage.googleapis.com") ||
              parsed.pathname.includes("generateContent") ||
              parsed.pathname.includes("streamGenerateContent")

            if (!isGeminiRequest) {
              return fetch(requestInput, init)
            }

            // Transform request to Code Assist API format
            const originalBody = init?.body ? JSON.parse(init.body.toString()) : {}

            // Extract model from the URL path (e.g., /v1beta/models/gemini-2.5-flash:streamGenerateContent)
            const modelMatch = parsed.pathname.match(/models\/([^:/]+)/)
            const modelName = modelMatch?.[1] || "gemini-2.5-flash"

            // Determine if streaming
            const isStreaming = parsed.pathname.includes("streamGenerateContent")

            // Build Code Assist request
            const codeAssistPayload = {
              model: modelName,
              project: cachedUserSetup.projectId,
              user_prompt_id: crypto.randomUUID(),
              request: {
                contents: originalBody.contents || [],
                generationConfig: originalBody.generationConfig || {
                  temperature: 1,
                  maxOutputTokens: 32000,
                },
                ...(originalBody.tools && { tools: originalBody.tools }),
                ...(originalBody.systemInstruction && { systemInstruction: originalBody.systemInstruction }),
              },
            }

            const codeAssistUrl = isStreaming
              ? `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:streamGenerateContent?alt=sse`
              : `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:generateContent`

            const headers = new Headers()
            headers.set("Content-Type", "application/json")
            headers.set("Authorization", `Bearer ${currentAuth.access}`)
            // IMPORTANT: Do NOT set X-Goog-User-Project header - it causes API enablement errors

            log.info("making code assist request", { url: codeAssistUrl, model: modelName })

            return fetch(codeAssistUrl, {
              method: "POST",
              headers,
              body: JSON.stringify(codeAssistPayload),
            })
          },
        }
      },
      methods: [
        {
          label: "OAuth with Google (Gemini CLI)",
          type: "oauth",
          authorize: async () => {
            const { redirectUri } = await startOAuthServer()
            const pkce = await generatePKCE()
            const state = generateState()
            const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

            const callbackPromise = waitForOAuthCallback(pkce, state)

            return {
              url: authUrl,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => {
                const tokens = await callbackPromise
                stopOAuthServer()
                return {
                  type: "success" as const,
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                }
              },
            }
          },
        },
      ],
    },
  }
}
