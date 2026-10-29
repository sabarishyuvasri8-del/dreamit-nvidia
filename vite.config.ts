import { defineConfig, loadEnv } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import webpush from 'web-push'
import { createClient } from '@supabase/supabase-js'

function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver',
    resolveId(id: string) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

/**
 * Local AI Proxy Plugin
 * Intercepts /api/ai-chat requests during local Vite development (npm run dev)
 * so that developers can test AI features without exposing keys to the client bundle.
 */
function localAiProxyPlugin(env: Record<string, string>) {
  return {
    name: 'local-ai-proxy',
    configureServer(server: any) {
      server.middlewares.use(async (req: any, res: any, next: any) => {
        if (req.url === '/api/ai-chat' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: any) => { body += chunk; });
          req.on('end', async () => {
            try {
              const parsedBody = JSON.parse(body || '{}');
              const apiKey =
                env.NVIDIA_API_KEY ||
                process.env.NVIDIA_API_KEY ||
                env.VITE_NVIDIA_API_KEY ||
                process.env.VITE_NVIDIA_API_KEY;

              if (!apiKey) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'NVIDIA_API_KEY not configured in .env' }));
                return;
              }

              const FALLBACK_MODELS = [
                'nvidia/nemotron-3.5-super-vl-120b-a12b',
                'meta/llama-3.3-70b-instruct',
                'nvidia/llama-3.1-nemotron-70b-instruct',
                'mistralai/mistral-large-2-instruct',
                'meta/llama-3.1-70b-instruct',
                'meta/llama-3.1-8b-instruct',
              ];

              const trimmedModel = (parsedBody.model || '').trim();
              const requestedModel = !trimmedModel
                ? 'nvidia/nemotron-3.5-super-vl-120b-a12b'
                : (trimmedModel === 'nemotron-3.5-super-vl-120b-a12b' || trimmedModel === 'nvidia/nemotron-3.5-super-vl-120b-a12b'
                    ? 'nvidia/nemotron-3.5-super-vl-120b-a12b'
                    : (trimmedModel.includes('/') ? trimmedModel : `nvidia/${trimmedModel}`));

              const candidateModels = Array.from(new Set([requestedModel, ...FALLBACK_MODELS]));

              const formattedMessages: Array<{ role: string; content: any }> = [];
              const rawMsgs = parsedBody.messages || [];

              for (let i = 0; i < rawMsgs.length; i++) {
                const m = rawMsgs[i];
                const isLastUser = m.role === 'user' && i === rawMsgs.length - 1;

                if (isLastUser && parsedBody.image && parsedBody.image.base64Data) {
                  formattedMessages.push({
                    role: 'user',
                    content: [
                      { type: 'text', text: m.content || 'Analyze this image and assist me.' },
                      {
                        type: 'image_url',
                        image_url: {
                          url: `data:${parsedBody.image.mimeType || 'image/jpeg'};base64,${parsedBody.image.base64Data}`,
                        },
                      },
                    ],
                  });
                } else {
                  formattedMessages.push({
                    role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
                    content: m.content || '',
                  });
                }
              }

              let content = '';
              let lastStatus = 0;
              let lastErrMsg = '';
              const nvidiaUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';

              for (let i = 0; i < candidateModels.length; i++) {
                const activeModel = candidateModels[i];
                const requestPayload = {
                  model: activeModel,
                  messages: formattedMessages,
                  temperature: typeof parsedBody.temperature === 'number' ? parsedBody.temperature : 0.2,
                  max_tokens: typeof parsedBody.max_tokens === 'number' ? Math.min(4096, parsedBody.max_tokens) : 4096,
                  ...(parsedBody.top_p ? { top_p: parsedBody.top_p } : {}),
                };

                try {
                  const nvidiaRes = await fetch(nvidiaUrl, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${apiKey.trim()}`,
                    },
                    body: JSON.stringify(requestPayload),
                  });

                  if (nvidiaRes.ok) {
                    const data = await nvidiaRes.json();
                    const choiceMsg = data.choices?.[0]?.message;
                    content = choiceMsg?.content || choiceMsg?.reasoning_content || '';
                    break;
                  }

                  lastStatus = nvidiaRes.status;
                  const errJson = await nvidiaRes.json().catch(() => ({}));
                  lastErrMsg = errJson?.error?.message || errJson?.detail || `NVIDIA API error (Status ${lastStatus})`;
                  console.warn(`[local-ai-proxy] NVIDIA Model ${activeModel} failed with ${lastStatus}: ${lastErrMsg}. Switching to next...`);
                } catch (netErr: any) {
                  lastErrMsg = netErr?.message || 'Network error';
                  console.warn(`[local-ai-proxy] Network error with ${activeModel}: ${lastErrMsg}`);
                }
              }

              if (!content && lastErrMsg) {
                res.statusCode = lastStatus || 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ content: '', error: lastErrMsg || 'All NVIDIA AI models exhausted' }));
                return;
              }

              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ content }));
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err?.message || 'Local AI proxy error' }));
            }
          });
        } else if (req.url?.startsWith('/api/link-preview')) {
          try {
            const urlObj = new URL(req.url, 'http://localhost');
            const targetUrl = urlObj.searchParams.get('url');
            if (!targetUrl) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Missing url parameter' }));
              return;
            }

            const parsedTarget = new URL(targetUrl);
            const hostname = parsedTarget.hostname.replace(/^www\./, '');
            const ytMatch = targetUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/);
            const youtubeId = ytMatch ? ytMatch[1] : undefined;

            if (youtubeId) {
              try {
                const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`);
                if (oembedRes.ok) {
                  const oembed = await oembedRes.json();
                  res.statusCode = 200;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({
                    url: targetUrl,
                    title: oembed.title || 'YouTube Video',
                    description: oembed.author_name
                      ? `Watch on YouTube • Channel: ${oembed.author_name}`
                      : 'Enjoy the videos and music you love, upload original content, and share it all with friends, family, and the world on YouTube.',
                    image: `https://img.youtube.com/vi/${youtubeId}/maxresdefault.jpg`,
                    siteName: oembed.provider_name || 'YouTube',
                    hostname,
                    favicon: 'https://www.youtube.com/s/desktop/f7129524/img/favicon.ico',
                    youtubeId,
                    mediaType: 'video',
                  }));
                  return;
                }
              } catch {}
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4500);

            const fetchRes = await fetch(targetUrl, {
              signal: controller.signal,
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8',
              },
              redirect: 'follow',
            });
            clearTimeout(timeoutId);

            const contentType = fetchRes.headers.get('content-type') || '';
            const favicon = `https://www.google.com/s2/favicons?domain=${hostname}&sz=64`;

            if (contentType.startsWith('image/')) {
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                url: targetUrl,
                title: parsedTarget.pathname.split('/').pop() || 'Image Preview',
                description: `Image on ${hostname}`,
                image: targetUrl,
                siteName: hostname,
                hostname,
                favicon,
                mediaType: 'image',
              }));
              return;
            }

            const html = (await fetchRes.text()).slice(0, 250000);
            const getMeta = (prop: string): string | null => {
              const r1 = new RegExp(`<meta[^>]*(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i');
              const r2 = new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
              const m = html.match(r1) || html.match(r2);
              return m ? m[1].trim() : null;
            };

            const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
            const rawTitle = getMeta('og:title') || getMeta('twitter:title') || (titleMatch ? titleMatch[1].trim() : '') || hostname;
            const rawDesc = getMeta('og:description') || getMeta('twitter:description') || getMeta('description') || '';
            let rawImage = getMeta('og:image') || getMeta('twitter:image') || '';

            if (youtubeId && (!rawImage || rawImage.includes('hqdefault'))) {
              rawImage = `https://img.youtube.com/vi/${youtubeId}/maxresdefault.jpg`;
            }

            if (rawImage && !rawImage.startsWith('http')) {
              try { rawImage = new URL(rawImage, targetUrl).href; } catch {}
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              url: targetUrl,
              title: rawTitle,
              description: rawDesc,
              image: rawImage || undefined,
              siteName: getMeta('og:site_name') || hostname,
              hostname,
              favicon,
              youtubeId,
              mediaType: youtubeId ? 'video' : undefined,
            }));
          } catch {
            const parsedTarget = new URL(req.url, 'http://localhost');
            const targetUrl = parsedTarget.searchParams.get('url') || '';
            let hostname = '';
            try { hostname = new URL(targetUrl).hostname.replace(/^www\./, ''); } catch {}
            const ytMatch = targetUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/);
            const youtubeId = ytMatch ? ytMatch[1] : undefined;

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              url: targetUrl,
              title: hostname || targetUrl,
              description: targetUrl,
              image: youtubeId ? `https://img.youtube.com/vi/${youtubeId}/maxresdefault.jpg` : undefined,
              hostname: hostname || 'link',
              siteName: hostname || 'link',
              favicon: hostname ? `https://www.google.com/s2/favicons?domain=${hostname}&sz=64` : undefined,
              youtubeId,
              mediaType: youtubeId ? 'video' : undefined,
            }));
          }
        } else if (req.url === '/api/send-push' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: any) => { body += chunk; });
          req.on('end', async () => {
            try {
              const parsed = JSON.parse(body || '{}');
              const { recipientId, senderId, senderName, bodySnippet } = parsed;

              const SUPABASE_PROJECT_ID = env.SUPABASE_PROJECT_ID || 'ogukrtsucsnxvrudvobv';
              const SUPABASE_URL = env.SUPABASE_URL || `https://${SUPABASE_PROJECT_ID}.supabase.co`;
              const SUPABASE_KEY =
                env.SUPABASE_SERVICE_ROLE_KEY ||
                env.SUPABASE_ANON_KEY ||
                'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ndWtydHN1Y3NueHZydWR2b2J2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2MDQ2MTksImV4cCI6MjEwMTE4MDYxOX0.cI7kzHbsSOYbiO3izp-sXhDinBMTCV5vmQXcllAfqy0';

              const VAPID_PUBLIC_KEY =
                env.VAPID_PUBLIC_KEY ||
                env.VITE_VAPID_PUBLIC_KEY ||
                'BMKEHNDgWBUAaPiWvn753OXxngSbuIFN2obnsGzYl4MeHDIDbFoPnf-NdpSMnA6VUfnRwR-8clEfK4RyRLPAleE';

              const VAPID_PRIVATE_KEY =
                env.VAPID_PRIVATE_KEY ||
                '9pXFfA-hfNMemTlefmPci2uKaRsWDT53knGkvO-ajQs';

              const VAPID_SUBJECT = env.VAPID_SUBJECT || 'mailto:support@dreamit.app';

              try {
                webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
              } catch {}

              const supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);
              const { data: subscriptions } = await supabaseClient
                .from('push_subscriptions')
                .select('*')
                .eq('user_id', recipientId);

              if (!subscriptions || subscriptions.length === 0) {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, sentCount: 0, message: 'No subscriptions found' }));
                return;
              }

              const payload = JSON.stringify({
                title: `${senderName || 'Friend'} • Dream It`,
                body: bodySnippet || 'Sent you a message',
                icon: '/icons/icon-192.png',
                badge: '/icons/icon-192.png',
                tag: `dreamit-dm-${senderId}`,
                friendId: senderId,
                url: `/?openChat=${encodeURIComponent(senderId)}`,
              });

              let sentCount = 0;
              const expiredEndpoints: string[] = [];

              await Promise.all(
                subscriptions.map(async (sub: any) => {
                  try {
                    await webpush.sendNotification(
                      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                      payload,
                      { TTL: 60 * 60 * 24, urgency: 'high' }
                    );
                    sentCount++;
                  } catch (err: any) {
                    if (err?.statusCode === 410 || err?.statusCode === 404) {
                      expiredEndpoints.push(sub.endpoint);
                    }
                  }
                })
              );

              if (expiredEndpoints.length > 0) {
                await supabaseClient.from('push_subscriptions').delete().in('endpoint', expiredEndpoints).catch(() => {});
              }

              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, sentCount, total: subscriptions.length }));
            } catch (pushErr: any) {
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: false, error: pushErr?.message || 'Push dispatch failed' }));
            }
          });
        } else {
          next();
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      figmaAssetResolver(),
      localAiProxyPlugin(env),
      // The React and Tailwind plugins are both required for Make, even if
      // Tailwind is not being actively used – do not remove them
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        // Alias @ to the src directory
        '@': path.resolve(__dirname, './src'),
      },
    },

    // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
    assetsInclude: ['**/*.svg', '**/*.csv'],
    build: {
      target: 'esnext',
      minify: 'esbuild',
      cssCodeSplit: true,
      rollupOptions: {
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom', 'react-router'],
            'ui-vendor': ['lucide-react'],
            'animation-vendor': ['motion'],
            'chart-vendor': ['recharts'],
            'supabase-vendor': ['@supabase/supabase-js'],
            'clerk-vendor': ['@clerk/clerk-react'],
            'markdown-vendor': ['react-markdown', 'remark-gfm'],
            'katex-vendor': ['katex', 'rehype-katex', 'remark-math'],
            'pdf-vendor': ['pdfjs-dist'],
            'sentry-vendor': ['@sentry/react'],
          }
        }
      }
    }
  };
});
