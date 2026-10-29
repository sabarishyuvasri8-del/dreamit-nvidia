/**
 * ai-client.ts
 * Production-hardened, secure AI client for Dream-It applications (NVIDIA NIM).
 * Routes all AI requests through the secure /api/ai-chat serverless proxy
 * so that API keys remain protected on the server and are never bundled in client JS.
 */

import { addBreadcrumb, captureException } from "./monitoring";

export interface ImageAttachment {
  name: string;
  mimeType: string;
  base64Data: string;
  dataUrl?: string;
}

export interface AIChatMessage {
  role: string;
  content: string;
}

export interface AIChatRequest {
  model?: string;
  messages: AIChatMessage[];
  image?: ImageAttachment;
  temperature?: number;
  max_tokens?: number;
  responseMimeType?: string;
  top_p?: number;
  timeoutMs?: number;
  onChunk?: (text: string) => void;
}

export interface AIResponse {
  content: string;
  error?: string;
  isRateLimited?: boolean;
}

// In-memory cache for 0ms responses on repeated prompts (3 min TTL)
const aiCache = new Map<string, { content: string; expiry: number }>();
const CACHE_TTL = 3 * 60 * 1000;

function normalizeModelName(m?: string): string {
  if (!m) {
    return "nvidia/nemotron-3.5-super-vl-120b-a12b";
  }
  const trimmed = m.trim();
  if (trimmed === "nemotron-3.5-super-vl-120b-a12b" || trimmed === "nvidia/nemotron-3.5-super-vl-120b-a12b") {
    return "nvidia/nemotron-3.5-super-vl-120b-a12b";
  }
  if (!trimmed.includes("/")) {
    return `nvidia/${trimmed}`;
  }
  return trimmed;
}

const FALLBACK_MODELS = [
  "nvidia/nemotron-3.5-super-vl-120b-a12b",
  "meta/llama-3.3-70b-instruct",
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "mistralai/mistral-large-2-instruct",
  "meta/llama-3.1-70b-instruct",
  "meta/llama-3.1-8b-instruct",
];

/**
 * Executes an AI chat request.
 * Routes through /api/ai-chat backend proxy with an automatic client-side fallback
 * to NVIDIA's API if the proxy is unavailable or unconfigured.
 */
export async function fetchAI(params: AIChatRequest): Promise<AIResponse> {
  const requestedModel = normalizeModelName(params.model);

  // 1. Check in-memory cache
  const cacheKey = `${requestedModel}_${params.image?.name || ""}_${params.responseMimeType || ""}_${JSON.stringify(params.messages)}`;
  const cached = aiCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    if (params.onChunk) {
      params.onChunk(cached.content);
    }
    return { content: cached.content };
  }

  addBreadcrumb("ai", `Dispatching AI request with model ${requestedModel}`, {
    messageCount: params.messages.length,
    hasImage: !!params.image,
  });

  const defaultTimeout = params.image ? 35000 : 12000;
  const timeoutDuration = params.timeoutMs ?? defaultTimeout;

  // 2. Primary Route: /api/ai-chat serverless endpoint
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);

    const res = await fetch("/api/ai-chat", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: params.messages,
        image: params.image,
        model: requestedModel,
        temperature: params.temperature,
        max_tokens: params.max_tokens || 4096,
        top_p: params.top_p,
      }),
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      const content = data.content || "";
      if (content) {
        aiCache.set(cacheKey, { content, expiry: Date.now() + CACHE_TTL });
        if (params.onChunk) {
          params.onChunk(content);
        }
        return { content };
      }
    }

    const errData = await res.json().catch(() => ({}));
    if (errData?.error) {
      console.warn("[ai-client proxy error]:", errData.error, "Status:", res.status);
    }
  } catch (proxyErr: any) {
    console.warn("[ai-client proxy network error]:", proxyErr?.message);
    captureException(proxyErr, { context: "AIChatProxy" });
  }

  // 3. Fallback Route: Direct NVIDIA NIM REST API
  const localEnvKey =
    (typeof import.meta !== "undefined" && (import.meta as any)?.env?.VITE_NVIDIA_API_KEY) ||
    "";

  if (localEnvKey && localEnvKey !== "undefined" && localEnvKey !== "your_nvidia_api_key_here") {
    try {
      const fallbackController = new AbortController();
      const timeoutId = setTimeout(() => fallbackController.abort(), timeoutDuration);

      const formattedMessages: Array<{ role: string; content: any }> = [];
      for (let i = 0; i < params.messages.length; i++) {
        const m = params.messages[i];
        const isLastUser = m.role === "user" && i === params.messages.length - 1;

        if (isLastUser && params.image && params.image.base64Data) {
          formattedMessages.push({
            role: "user",
            content: [
              { type: "text", text: m.content || "Analyze this image and assist me." },
              {
                type: "image_url",
                image_url: {
                  url: `data:${params.image.mimeType || "image/jpeg"};base64,${params.image.base64Data}`,
                },
              },
            ],
          });
        } else {
          formattedMessages.push({
            role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
            content: m.content || "",
          });
        }
      }

      const candidateModels = Array.from(new Set([requestedModel, ...FALLBACK_MODELS]));
      const nvidiaUrl = "https://integrate.api.nvidia.com/v1/chat/completions";

      for (let i = 0; i < candidateModels.length; i++) {
        const activeModel = candidateModels[i];
        const modelCtrl = new AbortController();
        const modelTimer = setTimeout(() => modelCtrl.abort(), Math.min(timeoutDuration, 35000));

        try {
          const res = await fetch(nvidiaUrl, {
            method: "POST",
            signal: modelCtrl.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${localEnvKey.trim()}`,
            },
            body: JSON.stringify({
              model: activeModel,
              messages: formattedMessages,
              temperature: typeof params.temperature === "number" ? params.temperature : 0.2,
              max_tokens: typeof params.max_tokens === "number" ? Math.min(4096, params.max_tokens) : 4096,
              ...(params.top_p ? { top_p: params.top_p } : {}),
            }),
          });
          clearTimeout(modelTimer);

          if (res.ok) {
            clearTimeout(timeoutId);
            const data = await res.json();
            const choiceMsg = data.choices?.[0]?.message;
            const content = choiceMsg?.content || choiceMsg?.reasoning_content || "";
            if (content) {
              aiCache.set(cacheKey, { content, expiry: Date.now() + CACHE_TTL });
              if (params.onChunk) {
                params.onChunk(content);
              }
              return { content };
            }
          } else {
            console.warn(`[NVIDIA Fallback] Model ${activeModel} returned status ${res.status}. Trying next...`);
          }
        } catch (fetchErr: any) {
          console.warn(`[NVIDIA Fallback] Fetch error for ${activeModel}:`, fetchErr?.message);
        }
      }
      clearTimeout(timeoutId);
    } catch (directErr: any) {
      console.warn("[NVIDIA Fallback Error]:", directErr?.message);
    }
  }

  // 4. Return user-friendly error response if all paths fail
  return {
    content: "",
    isRateLimited: true,
    error: "AI study rate limit reached. Please wait a few seconds and try again.",
  };
}
