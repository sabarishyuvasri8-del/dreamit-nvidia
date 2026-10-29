/**
 * api/ai-chat.ts
 * Secure Serverless Proxy for Dream-It AI services (NVIDIA NIM).
 * Runs on Vercel Serverless Functions and keeps API keys protected on the server.
 */

export default async function handler(req: any, res?: any) {
  // CORS Headers for preflight & cross-origin safety
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  // Handle preflight OPTIONS
  if (req.method === "OPTIONS") {
    if (res && typeof res.status === "function") {
      return res.status(204).end();
    }
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== "POST") {
    const errorBody = JSON.stringify({ error: "Method not allowed. Only POST is supported." });
    if (res && typeof res.status === "function") {
      return res.status(405).json({ error: "Method not allowed. Only POST is supported." });
    }
    return new Response(errorBody, { status: 405, headers });
  }

  try {
    // 1. Resolve NVIDIA API Key from server environment variables
    const apiKey =
      process.env.NVIDIA_API_KEY ||
      process.env.VITE_NVIDIA_API_KEY;

    if (!apiKey) {
      const errorMsg = "Server configuration error: NVIDIA_API_KEY is not configured on the server.";
      console.error("[api/ai-chat]", errorMsg);
      if (res && typeof res.status === "function") {
        return res.status(500).json({ error: errorMsg });
      }
      return new Response(JSON.stringify({ error: errorMsg }), { status: 500, headers });
    }

    // 2. Parse request body
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    } else if (!body && typeof req.json === "function") {
      body = await req.json();
    }

    const {
      messages = [],
      image,
      model = "nvidia/nemotron-3.5-super-vl-120b-a12b",
      temperature = 0.2,
      max_tokens = 4096,
      top_p,
    } = body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      const msg = "Invalid request: 'messages' must be a non-empty array.";
      if (res && typeof res.status === "function") {
        return res.status(400).json({ error: msg });
      }
      return new Response(JSON.stringify({ error: msg }), { status: 400, headers });
    }

    // 3. Format messages for NVIDIA NIM OpenAI-compatible API
    const formattedMessages: Array<{ role: string; content: any }> = [];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const isLastUser = m.role === "user" && i === messages.length - 1;

      if (isLastUser && image && image.base64Data) {
        formattedMessages.push({
          role: "user",
          content: [
            { type: "text", text: m.content || "Analyze this image and assist me." },
            {
              type: "image_url",
              image_url: {
                url: `data:${image.mimeType || "image/jpeg"};base64,${image.base64Data}`,
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

    // Candidate NVIDIA models for seamless multi-model failover
    const FALLBACK_MODELS = [
      "nvidia/nemotron-3.5-super-vl-120b-a12b",
      "meta/llama-3.3-70b-instruct",
      "nvidia/llama-3.1-nemotron-70b-instruct",
      "mistralai/mistral-large-2-instruct",
      "meta/llama-3.1-70b-instruct",
      "meta/llama-3.1-8b-instruct",
    ];

    const trimmedModel = (model || "").trim();
    const requestedModel = !trimmedModel
      ? "nvidia/nemotron-3.5-super-vl-120b-a12b"
      : (trimmedModel === "nemotron-3.5-super-vl-120b-a12b" || trimmedModel === "nvidia/nemotron-3.5-super-vl-120b-a12b"
          ? "nvidia/nemotron-3.5-super-vl-120b-a12b"
          : (trimmedModel.includes("/") ? trimmedModel : `nvidia/${trimmedModel}`));
    const candidateModels = Array.from(new Set([requestedModel, ...FALLBACK_MODELS]));

    // 4. Dispatch request to NVIDIA NIM API with failover
    let finalContent = "";
    let lastErrorStatus = 0;
    let lastErrorMessage = "";

    const nvidiaUrl = "https://integrate.api.nvidia.com/v1/chat/completions";

    for (let i = 0; i < candidateModels.length; i++) {
      const currentModel = candidateModels[i];
      const modelCtrl = new AbortController();
      const modelTimer = setTimeout(() => modelCtrl.abort(), 35000);

      try {
        const payload: any = {
          model: currentModel,
          messages: formattedMessages,
          temperature: typeof temperature === "number" ? temperature : 0.2,
          max_tokens: typeof max_tokens === "number" ? Math.min(4096, max_tokens) : 4096,
          ...(top_p ? { top_p } : {}),
        };

        const nvidiaRes = await fetch(nvidiaUrl, {
          method: "POST",
          signal: modelCtrl.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey.trim()}`,
          },
          body: JSON.stringify(payload),
        });

        clearTimeout(modelTimer);

        if (nvidiaRes.ok) {
          const resData = await nvidiaRes.json();
          const choiceMsg = resData.choices?.[0]?.message;
          finalContent = choiceMsg?.content || choiceMsg?.reasoning_content || "";
          break;
        }

        lastErrorStatus = nvidiaRes.status;
        const errJson = await nvidiaRes.json().catch(() => ({}));
        lastErrorMessage = errJson?.error?.message || errJson?.detail || `NVIDIA API error (Status ${lastErrorStatus})`;
        console.warn(`[api/ai-chat] NVIDIA Model ${currentModel} returned ${lastErrorStatus} (${lastErrorMessage}). Switching to next fallback model...`);
      } catch (networkErr: any) {
        lastErrorMessage = networkErr?.message || "Network error";
        console.warn(`[api/ai-chat] Network error calling NVIDIA ${currentModel}: ${lastErrorMessage}`);
      }
    }

    if (!finalContent && lastErrorMessage) {
      console.error("[api/ai-chat] All candidate NVIDIA models exhausted without success. Last error:", lastErrorMessage);
      if (lastErrorStatus === 429) {
        const payload = {
          content: "",
          isRateLimited: true,
          error: "AI rate limit reached across all models. Please wait a few seconds and try again.",
        };
        if (res && typeof res.status === "function") {
          return res.status(429).json(payload);
        }
        return new Response(JSON.stringify(payload), { status: 429, headers });
      }

      const payload = { content: "", error: lastErrorMessage || "Unable to generate response from NVIDIA AI models." };
      if (res && typeof res.status === "function") {
        return res.status(lastErrorStatus >= 500 ? 502 : (lastErrorStatus || 500)).json(payload);
      }
      return new Response(JSON.stringify(payload), { status: lastErrorStatus >= 500 ? 502 : (lastErrorStatus || 500), headers });
    }

    const successPayload = { content: finalContent };
    if (res && typeof res.status === "function") {
      return res.status(200).json(successPayload);
    }
    return new Response(JSON.stringify(successPayload), { status: 200, headers });
  } catch (err: any) {
    console.error("[api/ai-chat] Internal handler error:", err);
    const errorPayload = { content: "", error: err?.message || "Internal server error." };
    if (res && typeof res.status === "function") {
      return res.status(500).json(errorPayload);
    }
    return new Response(JSON.stringify(errorPayload), { status: 500, headers });
  }
}
