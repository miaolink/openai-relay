/**
 * OpenAI 标准协议中转 + Web 管理后台
 *
 * Wrangler 需绑定 KV（binding 名 KV）并设置 PASSWORD：
 *   [[kv_namespaces]]
 *   binding = "KV"
 *   id = "你的KV_ID"
 *
 * 环境变量：
 *   PASSWORD          — 管理后台登录密码（必填才开放后台）
 *   KEY               — Cookie 加盐（可选，默认内置）
 *   OPENAI_BASE_URL   — 初始上游（KV 无配置时）
 *   OPENAI_API_KEY    — 初始上游 Key
 *   PROXY_SECRET      — 初始本地 Token（客户端 apiKey）
 *
 * 客户端：baseURL = https://域名/v1 ，apiKey = 后台「本地 Token」
 * Worker 将 Bearer 本地 Token 替换为上游真实 Key 后转发。
 *
 * 缓存：相同非流式请求写入 KV（前缀 ocache:），命中则不请求上游，节省 Token。
 * 跳过：X-Cache-Bypass: 1 或 ?no_cache=1
 *
 * 模型探测：定时/手动测试上游模型，GET /v1/models 仅返回可用列表。
 * Cron（wrangler-relay.toml）：每 30 分钟触发 scheduled。
 */

const KV_KEY = 'relay.json';
const MODELS_KV_KEY = 'models_state.json';
const CACHE_PREFIX = 'ocache:';
const DEFAULT_PROBE_INTERVAL_MIN = 30;
const MODEL_TEST_TIMEOUT_MS = 10000;
const MODEL_PROBE_PARALLEL = 4;
const MODEL_PROBE_MAX = 30;
const PROBE_LOCK_TTL_MS = 8 * 60 * 1000;
const PROBE_WALL_MAX_MS = 28000;
const CACHE_MAX_BODY = 1024 * 1024; // 1MB，超过不缓存
const DEFAULT_UPSTREAM = 'https://api.openai.com';
const ADMIN_COOKIE = 'relay_auth';
const BRAND_NAME = '融合网络-OpenAI中转';

const DEFAULT_CACHE = {
    enabled: false,
    ttlSeconds: 86400,
    chatCompletions: true,
    embeddings: true,
    completions: true,
    onlyTemperatureZero: false,
};

const DEFAULT_MODEL_PROBE = {
    enabled: true,
    intervalMinutes: DEFAULT_PROBE_INTERVAL_MIN,
    filterModels: true,
    blockUnavailable: false,
    maxModels: MODEL_PROBE_MAX,
};

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, api-key, x-api-key, OpenAI-Beta, X-Proxy-Key',
    'Access-Control-Max-Age': '86400',
};

const HOP_BY_HOP = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
    'proxy-authorization', 'proxy-authenticate', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-worker', 'x-proxy-key',
]);

export default {
    async fetch(request, env, ctx) {
        try {
            ctx.waitUntil(maybeAutoProbeModels(env));
            return await handleRequest(request, env, ctx);
        } catch (e) {
            console.error(e);
            return json({ error: { message: e?.message || String(e), type: 'server_error' } }, 500);
        }
    },
    // Wrangler crons: 每 30 分钟 → ["0,30 * * * * *"] 或 ["*/30 * * * *"]
    async scheduled(event, env, ctx) {
        ctx.waitUntil(runModelProbeJob(env, 'cron'));
    },
};

async function handleRequest(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const UA = request.headers.get('User-Agent') || 'null';

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (path === '/login') return handleLogin(request, env, UA);
        if (path === '/logout') return handleLogout(request);

        if (path === '/admin' || path.startsWith('/admin/')) {
            return handleAdmin(request, env, UA, path, url, ctx);
        }

        if (path === '/health') {
            const cfg = await loadRelayConfig(env);
            return json({
                ok: cfg.enabled && !!cfg.upstreamApiKey && !!cfg.clientToken,
                upstream: cfg.upstreamBaseUrl,
                enabled: cfg.enabled,
            }, 200);
        }

        if (path === '/' || path === '') {
            const adminPwd = getAdminPassword(env);
            if (adminPwd) {
                return Response.redirect(`${url.origin}/admin`, 302);
            }
            return json({
                name: BRAND_NAME,
                admin: adminPwd ? `${url.origin}/admin` : '请配置 PASSWORD 后访问 /admin',
                api: `${url.origin}/v1`,
            });
        }

        if (path === '/v1' || path.startsWith('/v1/')) {
            const cfg = await loadRelayConfig(env);
            if (!cfg.enabled) {
                return openaiError('server_error', '中转已禁用', 503);
            }
            const clientKey = extractClientKey(request);
            if (!clientKey || clientKey !== cfg.clientToken) {
                return openaiError('invalid_api_key', 'Incorrect API key provided', 401);
            }
            if (!cfg.upstreamApiKey) {
                return openaiError('server_error', '未配置上游 API Key，请登录管理后台', 500);
            }
            const subPath = path === '/v1' ? '' : path.slice(4);
            return proxyOpenAI(request, cfg, subPath + url.search, env, ctx);
        }

        return openaiError('not_found', `Unknown URL: ${path}`, 404);
}

// ─── 配置 ───────────────────────────────────────────────────────────

function defaultRelayFromEnv(env) {
    return {
        upstreamBaseUrl: (env.OPENAI_BASE_URL || env.BASE_URL || DEFAULT_UPSTREAM).trim().replace(/\/+$/, ''),
        upstreamApiKey: (env.OPENAI_API_KEY || env.API_KEY || '').trim(),
        clientToken: (env.PROXY_SECRET || env.PROXY_AUTH_TOKEN || '').trim(),
        enabled: true,
        updatedAt: null,
        cache: { ...DEFAULT_CACHE },
        cacheStats: { hits: 0, misses: 0, saved: 0 },
        modelProbe: { ...DEFAULT_MODEL_PROBE },
        availableModels: [],
        modelsProbeAt: null,
    };
}

function normalizeModelProbeConfig(raw) {
    const p = { ...DEFAULT_MODEL_PROBE, ...(raw || {}) };
    p.enabled = p.enabled !== false;
    p.intervalMinutes = Math.max(5, Math.min(1440, parseInt(p.intervalMinutes, 10) || DEFAULT_PROBE_INTERVAL_MIN));
    p.filterModels = p.filterModels !== false;
    p.blockUnavailable = !!p.blockUnavailable;
    p.maxModels = Math.max(1, Math.min(200, parseInt(p.maxModels, 10) || MODEL_PROBE_MAX));
    return p;
}

function normalizeCacheConfig(raw) {
    const c = { ...DEFAULT_CACHE, ...(raw || {}) };
    c.enabled = !!c.enabled;
    c.ttlSeconds = Math.max(60, Math.min(604800, parseInt(c.ttlSeconds, 10) || DEFAULT_CACHE.ttlSeconds));
    c.chatCompletions = c.chatCompletions !== false;
    c.embeddings = c.embeddings !== false;
    c.completions = c.completions !== false;
    c.onlyTemperatureZero = !!c.onlyTemperatureZero;
    return c;
}

async function loadRelayConfig(env) {
    const fallback = defaultRelayFromEnv(env);
    if (!env.KV) return { ...fallback };

    try {
        const raw = await env.KV.get(KV_KEY);
        if (!raw) {
            if (fallback.upstreamApiKey || fallback.clientToken) {
                await env.KV.put(KV_KEY, JSON.stringify({ ...fallback, updatedAt: new Date().toISOString() }));
            }
            return { ...fallback };
        }
        const saved = JSON.parse(raw);
        return {
            upstreamBaseUrl: (saved.upstreamBaseUrl || fallback.upstreamBaseUrl).replace(/\/+$/, ''),
            upstreamApiKey: saved.upstreamApiKey || fallback.upstreamApiKey,
            clientToken: saved.clientToken || fallback.clientToken,
            enabled: saved.enabled !== false,
            updatedAt: saved.updatedAt || null,
            cache: normalizeCacheConfig(saved.cache),
            cacheStats: saved.cacheStats || { hits: 0, misses: 0, saved: 0 },
            modelProbe: normalizeModelProbeConfig(saved.modelProbe),
            availableModels: Array.isArray(saved.availableModels) ? saved.availableModels : [],
            modelsProbeAt: saved.modelsProbeAt || null,
        };
    } catch {
        return { ...fallback };
    }
}

async function saveRelayConfig(env, patch) {
    const current = await loadRelayConfig(env);
    const next = {
        upstreamBaseUrl: (patch.upstreamBaseUrl ?? current.upstreamBaseUrl).trim().replace(/\/+$/, ''),
        upstreamApiKey: patch.upstreamApiKey ?? current.upstreamApiKey,
        clientToken: patch.clientToken ?? current.clientToken,
        enabled: patch.enabled !== undefined ? !!patch.enabled : current.enabled,
        cache: patch.cache ? normalizeCacheConfig({ ...current.cache, ...patch.cache }) : current.cache,
        cacheStats: patch.cacheStats ?? current.cacheStats,
        modelProbe: patch.modelProbe ? normalizeModelProbeConfig({ ...current.modelProbe, ...patch.modelProbe }) : current.modelProbe,
        updatedAt: new Date().toISOString(),
    };
    if (!env.KV) throw new Error('未绑定 KV（binding 名称须为 KV）');
    await env.KV.put(KV_KEY, JSON.stringify(next));
    return next;
}

function configForAdmin(cfg, origin) {
    return {
        upstreamBaseUrl: cfg.upstreamBaseUrl,
        upstreamApiKey: cfg.upstreamApiKey || '',
        upstreamApiKeySet: !!cfg.upstreamApiKey,
        clientToken: cfg.clientToken || '',
        clientTokenSet: !!cfg.clientToken,
        enabled: cfg.enabled,
        updatedAt: cfg.updatedAt,
        clientBaseUrl: `${origin}/v1`,
        cache: cfg.cache,
        cacheStats: cfg.cacheStats,
        modelProbe: cfg.modelProbe,
        availableModels: cfg.availableModels || [],
        modelsProbeAt: cfg.modelsProbeAt || null,
    };
}

async function loadModelsState(env) {
    const empty = {
        lastProbeAt: null,
        lastProbeSource: null,
        upstreamBaseUrl: null,
        probing: false,
        allCount: 0,
        available: [],
        results: [],
    };
    if (!env.KV) return empty;
    try {
        const raw = await env.KV.get(MODELS_KV_KEY);
        if (!raw) return empty;
        return { ...empty, ...JSON.parse(raw) };
    } catch {
        return empty;
    }
}

async function saveModelsState(env, state) {
    if (!env.KV) throw new Error('未绑定 KV');
    const payload = {
        ...state,
        available: [...new Set((state.available || []).filter(Boolean))],
    };
    await env.KV.put(MODELS_KV_KEY, JSON.stringify(payload));
}

/** 合并 KV models_state + relay.json 中的可用模型快照 */
async function getAvailableModelsState(env, cfg) {
    let state = await loadModelsState(env);
    if (state.probing && isProbeLockStale(state)) {
        state = { ...state, probing: false };
        await saveModelsState(env, state);
    }
    const relay = cfg || (env.KV ? await loadRelayConfig(env) : null);
    const relayIds = relay?.availableModels || [];
    if (!state.available?.length && relayIds.length) {
        state = {
            ...state,
            available: relayIds,
            models: state.models?.length ? state.models : buildModelListItems({ available: relayIds }),
            lastProbeAt: state.lastProbeAt || relay?.modelsProbeAt || null,
        };
    }
    return state;
}

async function syncAvailableToRelay(env, available, probeAt) {
    if (!env.KV || !available?.length) return;
    const cfg = await loadRelayConfig(env);
    await saveRelayConfig(env, {
        ...cfg,
        availableModels: [...new Set(available)],
        modelsProbeAt: probeAt,
    });
}

// ─── 管理后台鉴权 ───────────────────────────────────────────────────

function getAdminPassword(env) {
    const p = env.PASSWORD || env.ADMIN || env.password;
    return p && typeof p === 'string' ? p.trim() : '';
}

function getAuthSalt(env) {
    return env.AUTH_SALT || env.KEY || 'relay-default-salt-change-me';
}

async function expectedAuthCookie(UA, env) {
    const pwd = getAdminPassword(env);
    if (!pwd) return null;
    return hashString(UA + getAuthSalt(env) + pwd);
}

function getAuthCookie(request) {
    const cookies = request.headers.get('Cookie') || '';
    return cookies.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${ADMIN_COOKIE}=`))?.split('=').slice(1).join('=');
}

async function requireAdmin(request, env, UA) {
    const pwd = getAdminPassword(env);
    if (!pwd) return { ok: false, status: 503, message: '未配置 PASSWORD，管理后台已关闭' };
    const expected = await expectedAuthCookie(UA, env);
    const got = getAuthCookie(request);
    if (!got || got !== expected) return { ok: false, status: 401, message: '未登录' };
    return { ok: true };
}

async function handleLogin(request, env, UA) {
    const pwd = getAdminPassword(env);
    if (!pwd) {
        return htmlResponse(`<h1>${BRAND_NAME}</h1><p>未配置 PASSWORD，请在 Worker 环境变量中设置。</p>`, 503);
    }
    const expected = await expectedAuthCookie(UA, env);
    if (getAuthCookie(request) === expected) {
        return Response.redirect(`${new URL(request.url).origin}/admin`, 302);
    }
    if (request.method === 'POST') {
        let input = '';
        const ct = request.headers.get('Content-Type') || '';
        if (ct.includes('application/json')) {
            const j = await request.json();
            input = j.password || '';
        } else {
            const params = new URLSearchParams(await request.text());
            input = params.get('password') || '';
        }
        if (input === pwd) {
            const res = json({ success: true });
            res.headers.set('Set-Cookie', `${ADMIN_COOKIE}=${expected}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`);
            return res;
        }
        return json({ success: false, error: '密码错误' }, 401);
    }
    return htmlResponse(LOGIN_HTML, 200);
}

function handleLogout(request) {
    const login = `${new URL(request.url).origin}/login`;
    const res = Response.redirect(login, 302);
    res.headers.set('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly`);
    return res;
}

async function handleAdmin(request, env, UA, path, url, ctx) {
    const auth = await requireAdmin(request, env, UA);
    if (!auth.ok) {
        if (path.startsWith('/admin/api/')) return json({ error: auth.message }, auth.status);
        if (auth.status === 401) return Response.redirect(`${url.origin}/login`, 302);
        return htmlResponse(`<h1>${auth.message}</h1>`, auth.status);
    }

    const origin = url.origin;

    if (path === '/admin/api/config' && request.method === 'GET') {
        const cfg = await loadRelayConfig(env);
        const out = configForAdmin(cfg, origin);
        out.hasKv = !!env.KV;
        return json(out);
    }

    if (path === '/admin/api/config' && request.method === 'POST') {
        try {
            const body = await request.json();
            const current = await loadRelayConfig(env);
            const patch = {
                upstreamBaseUrl: body.upstreamBaseUrl,
                enabled: body.enabled,
            };
            if (typeof body.upstreamApiKey === 'string' && body.upstreamApiKey.trim()) {
                patch.upstreamApiKey = body.upstreamApiKey.trim();
            }
            if (typeof body.clientToken === 'string' && body.clientToken.trim()) {
                patch.clientToken = body.clientToken.trim();
            }
            if (body.cache && typeof body.cache === 'object') {
                patch.cache = normalizeCacheConfig({ ...current.cache, ...body.cache });
            }
            if (body.modelProbe && typeof body.modelProbe === 'object') {
                patch.modelProbe = normalizeModelProbeConfig({ ...current.modelProbe, ...body.modelProbe });
            }
            const saved = await saveRelayConfig(env, { ...current, ...patch });
            return json({ success: true, config: configForAdmin(saved, origin) });
        } catch (e) {
            return json({ success: false, error: e.message }, 500);
        }
    }

    if (path === '/admin/api/regen-token' && request.method === 'POST') {
        const token = 'sk-relay-' + (await randomHex(24));
        const saved = await saveRelayConfig(env, { ...(await loadRelayConfig(env)), clientToken: token });
        return json({ success: true, clientToken: token, config: configForAdmin(saved, origin) });
    }

    if (path === '/admin/api/test' && request.method === 'POST') {
        const cfg = await loadRelayConfig(env);
        if (!cfg.upstreamApiKey) return json({ success: false, error: '未配置上游 Key' }, 400);
        try {
            const base = cfg.upstreamBaseUrl.replace(/\/+$/, '');
            const res = await fetch(`${base}/v1/models`, {
                headers: { Authorization: `Bearer ${cfg.upstreamApiKey}` },
            });
            const data = await res.json().catch(() => ({}));
            return json({ success: res.ok, status: res.status, data }, res.ok ? 200 : 502);
        } catch (e) {
            return json({ success: false, error: e.message }, 502);
        }
    }

    if (path === '/admin/api/cache/clear' && request.method === 'POST') {
        const n = await clearResponseCache(env);
        const cfg = await loadRelayConfig(env);
        const saved = await saveRelayConfig(env, {
            ...cfg,
            cacheStats: { hits: 0, misses: 0, saved: 0 },
        });
        return json({ success: true, deleted: n, cacheStats: saved.cacheStats });
    }

    if (path === '/admin/api/cache/stats' && request.method === 'GET') {
        const cfg = await loadRelayConfig(env);
        const entries = await countCacheEntries(env);
        return json({ cache: cfg.cache, cacheStats: cfg.cacheStats, entries });
    }

    if (path === '/admin/api/models' && request.method === 'GET') {
        let cfg = await loadRelayConfig(env);
        const state = await getAvailableModelsState(env, cfg);
        if (state.available?.length && state.available.length !== (cfg.availableModels || []).length) {
            await syncAvailableToRelay(env, state.available, state.lastProbeAt);
            cfg = await loadRelayConfig(env);
        }
        const preview = buildModelListItems(state);
        const resultMap = new Map((state.results || []).map((r) => [r.id, r]));
        const availableDetail = (state.available || []).map((id) => {
            const r = resultMap.get(id);
            return {
                id,
                latencyMs: r?.latencyMs ?? null,
                kind: r?.kind ?? null,
            };
        });
        return json({
            modelProbe: cfg.modelProbe,
            models: state,
            kvStore: {
                key: MODELS_KV_KEY,
                availableIds: state.available || [],
                availableCount: (state.available || []).length,
                lastProbeAt: state.lastProbeAt,
                upstreamBaseUrl: state.upstreamBaseUrl,
                probing: !!state.probing,
            },
            relayStore: {
                key: KV_KEY,
                field: 'availableModels',
                availableIds: cfg.availableModels || [],
                modelsProbeAt: cfg.modelsProbeAt,
            },
            clientPreview: { object: 'list', data: preview, count: preview.length },
            availableDetail,
        });
    }

    if (path === '/admin/api/models/sync' && request.method === 'POST') {
        const cfg = await loadRelayConfig(env);
        const state = await getAvailableModelsState(env, cfg);
        if (!state.available?.length) return json({ success: false, error: '无可用模型可同步' }, 400);
        await syncAvailableToRelay(env, state.available, state.lastProbeAt || new Date().toISOString());
        const preview = buildModelListItems(state);
        return json({ success: true, count: preview.length, available: state.available });
    }

    if (path === '/admin/api/models/unlock' && request.method === 'POST') {
        const state = await loadModelsState(env);
        state.probing = false;
        state.lastError = '已手动解锁';
        await saveModelsState(env, state);
        return json({ success: true, message: '探测锁已清除' });
    }

    if (path === '/admin/api/models/probe' && request.method === 'POST') {
        const cfg = await loadRelayConfig(env);
        if (!cfg.upstreamApiKey) return json({ success: false, error: '未配置上游 Key' }, 400);
        const result = await probeUpstreamModels(env, cfg, 'manual', { force: true });
        return json({ success: !result.error, ...result }, result.error ? 502 : 200);
    }

    if (path === '/admin' || path === '/admin/') {
        return htmlResponse(ADMIN_HTML.replace(/\{\{ORIGIN\}\}/g, origin), 200);
    }

    return json({ error: 'Not Found' }, 404);
}

// ─── 上游代理 ─────────────────────────────────────────────────────────

/** 客户端密钥：支持 Bearer（OpenAI SDK）与 api-key（Cursor 等） */
function extractClientKey(request) {
    const auth = request.headers.get('Authorization') || '';
    const bearer = auth.match(/^Bearer\s+(.+)$/i);
    if (bearer) return bearer[1].trim();
    const apiKey = request.headers.get('api-key') || request.headers.get('x-api-key');
    if (apiKey) return apiKey.trim();
    return null;
}

async function proxyOpenAI(request, cfg, subPath, env, ctx) {
    const base = cfg.upstreamBaseUrl.replace(/\/+$/, '');
    const pathOnly = (subPath.startsWith('/') ? subPath : `/${subPath}`).split('?')[0];
    const pathLower = pathOnly.toLowerCase();
    const isModelsList = request.method === 'GET' && /^\/models\/?$/i.test(pathLower);
    const wantAllModels = request.headers.get('X-Models-All') === '1'
        || new URL(request.url).searchParams.has('all_models');

    if (isModelsList && cfg.modelProbe?.filterModels !== false && !wantAllModels) {
        const filtered = await buildFilteredModelsResponse(cfg, env);
        const extra = {
            'X-Proxy-Models': 'filtered',
            'X-Proxy-Models-Count': String(filtered.data?.length || 0),
            'X-Proxy-Models-Source': filtered.source || 'kv',
        };
        if (filtered._warn) extra['X-Proxy-Models-Warn'] = filtered._warn;
        return openaiJsonResponse(filtered, 200, extra);
    }

    const targetUrl = `${base}/v1${subPath.startsWith('/') ? subPath : `/${subPath}`}`;

    const bypassCache = request.headers.get('X-Cache-Bypass') === '1'
        || new URL(request.url).searchParams.has('no_cache');

    let bodyBytes = null;
    let bodyJson = null;
    if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
        bodyBytes = await request.arrayBuffer();
        const ct = request.headers.get('Content-Type') || '';
        if (ct.includes('application/json') && bodyBytes.byteLength) {
            try {
                bodyJson = JSON.parse(new TextDecoder().decode(bodyBytes));
            } catch { /* ignore */ }
        }
    }

    if (cfg.modelProbe?.blockUnavailable && bodyJson?.model) {
        const state = await loadModelsState(env);
        if (state.available?.length && !state.available.includes(bodyJson.model)) {
            return openaiError('invalid_request_error', `模型 ${bodyJson.model} 不可用或未通过探测`, 400);
        }
    }

    const cacheCtx = getCacheContext(cfg, pathOnly, bodyJson, bypassCache);
    if (cacheCtx && env.KV) {
        cacheCtx.kvKey = CACHE_PREFIX + await sha256Hex(cacheCtx.cacheKey);
        const hit = await getCachedResponse(env, cacheCtx.kvKey);
        if (hit) {
            ctx?.waitUntil(bumpCacheStats(env, 'hits'));
            return buildCachedResponse(hit, 'HIT');
        }
        ctx?.waitUntil(bumpCacheStats(env, 'misses'));
    }

    const forwardHeaders = new Headers();
    for (const [k, v] of request.headers) {
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk) || lk === 'authorization' || lk === 'api-key' || lk === 'x-api-key') continue;
        forwardHeaders.set(k, v);
    }
    forwardHeaders.set('Authorization', `Bearer ${cfg.upstreamApiKey}`);

    const body = bodyBytes && bodyBytes.byteLength ? bodyBytes : undefined;

    try {
        const res = await fetch(targetUrl, { method: request.method, headers: forwardHeaders, body, redirect: 'follow' });
        const resBody = await res.arrayBuffer();

        if (cacheCtx && env.KV && res.ok && resBody.byteLength && resBody.byteLength <= CACHE_MAX_BODY) {
            const ct = res.headers.get('Content-Type') || '';
            if (ct.includes('application/json')) {
                const entry = {
                    status: res.status,
                    contentType: ct,
                    body: new TextDecoder().decode(resBody),
                    cachedAt: new Date().toISOString(),
                };
                ctx?.waitUntil(
                    env.KV.put(cacheCtx.kvKey, JSON.stringify(entry), {
                        expirationTtl: cfg.cache.ttlSeconds,
                    }).then(() => bumpCacheStats(env, 'saved')),
                );
            }
        }

        const outHeaders = buildOutHeaders(res.headers, cacheCtx ? 'MISS' : 'SKIP');
        return new Response(resBody, { status: res.status, statusText: res.statusText, headers: outHeaders });
    } catch (e) {
        return openaiError('server_error', e.message || 'Upstream fetch failed', 502);
    }
}

function getCacheContext(cfg, apiPath, bodyJson, bypassCache) {
    if (bypassCache || !cfg.cache?.enabled || !bodyJson) return null;
    const p = apiPath.toLowerCase();
    const rules = cfg.cache;
    const isChat = p === '/chat/completions' || p.endsWith('/chat/completions');
    const isEmbed = p === '/embeddings' || p.endsWith('/embeddings');
    const isCompletion = p === '/completions' || p.endsWith('/completions');
    if (bodyJson.stream === true) return null;
    if (isChat && !rules.chatCompletions) return null;
    if (isEmbed && !rules.embeddings) return null;
    if (isCompletion && !rules.completions) return null;
    if (!isChat && !isEmbed && !isCompletion) return null;
    if (rules.onlyTemperatureZero && bodyJson.temperature != null && bodyJson.temperature !== 0) return null;

    const normalized = normalizeBodyForCache(bodyJson);
    const cacheKey = `${cfg.upstreamBaseUrl}|${p}|${stableStringify(normalized)}`;
    return { cacheKey, apiPath: p };
}

function normalizeBodyForCache(body) {
    const skip = new Set(['user', 'stream', 'stream_options', 'request_id', 'metadata', 'store']);
    const out = {};
    for (const k of Object.keys(body).sort()) {
        if (!skip.has(k)) out[k] = body[k];
    }
    return out;
}

function stableStringify(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

async function getCachedResponse(env, kvKey) {
    const raw = await env.KV.get(kvKey);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function buildCachedResponse(entry, cacheStatus) {
    const headers = buildOutHeaders(new Headers({ 'Content-Type': entry.contentType || 'application/json' }), cacheStatus);
    headers.set('X-Proxy-Cache-At', entry.cachedAt || '');
    return new Response(entry.body, { status: entry.status || 200, headers });
}

function buildOutHeaders(sourceHeaders, cacheStatus) {
    const outHeaders = new Headers();
    const src = sourceHeaders instanceof Headers ? sourceHeaders : new Headers(sourceHeaders);
    for (const [k, v] of src) {
        const lower = k.toLowerCase();
        if (lower === 'content-encoding' || lower === 'content-length') continue;
        outHeaders.set(k, v);
    }
    Object.entries(CORS_HEADERS).forEach(([k, v]) => outHeaders.set(k, v));
    outHeaders.set('X-Proxy-Cache', cacheStatus);
    return outHeaders;
}

async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function bumpCacheStats(env, field) {
    if (!env.KV) return;
    try {
        const cfg = await loadRelayConfig(env);
        const stats = { ...cfg.cacheStats, [field]: (cfg.cacheStats[field] || 0) + 1 };
        await saveRelayConfig(env, { ...cfg, cacheStats: stats });
    } catch { /* ignore */ }
}

async function countCacheEntries(env) {
    if (!env.KV) return 0;
    let total = 0;
    let cursor;
    do {
        const list = await env.KV.list({ prefix: CACHE_PREFIX, cursor, limit: 1000 });
        total += list.keys.length;
        cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
    return total;
}

async function clearResponseCache(env) {
    if (!env.KV) return 0;
    let deleted = 0;
    let cursor;
    do {
        const list = await env.KV.list({ prefix: CACHE_PREFIX, cursor, limit: 500 });
        await Promise.all(list.keys.map((k) => env.KV.delete(k.name)));
        deleted += list.keys.length;
        cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
    return deleted;
}

// ─── 工具 ─────────────────────────────────────────────────────────────

async function hashString(text) {
    const enc = new TextEncoder();
    const md5 = async (data) => {
        const buf = await crypto.subtle.digest({ name: 'MD5' }, data);
        return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    const hex1 = await md5(enc.encode(text));
    return (await md5(enc.encode(hex1.slice(7, 27)))).toLowerCase();
}

async function randomHex(bytes) {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function openaiError(type, message, status) {
    return json({ error: { message, type, param: null, code: type } }, status);
}

function json(data, status = 200, extraHeaders = {}) {
    const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders };
    return new Response(JSON.stringify(data, null, 2), { status, headers });
}

// ─── 模型探测 ─────────────────────────────────────────────────────────

function isProbeLockStale(state) {
    if (!state?.probing) return false;
    const t = state.probeStartedAt ? new Date(state.probeStartedAt).getTime() : 0;
    if (!t) return true;
    return Date.now() - t > PROBE_LOCK_TTL_MS;
}

async function clearProbeLock(env, reason) {
    const state = await loadModelsState(env);
    if (!state.probing) return state;
    state.probing = false;
    if (reason) state.lastError = reason;
    await saveModelsState(env, state);
    return state;
}

async function maybeAutoProbeModels(env) {
    const cfg = await loadRelayConfig(env);
    if (!cfg.modelProbe?.enabled || !cfg.upstreamApiKey || !env.KV) return;
    const state = await loadModelsState(env);
    if (state.probing && !isProbeLockStale(state)) return;
    if (state.probing) await clearProbeLock(env, '自动探测：上次任务超时已解锁');
    const intervalMs = (cfg.modelProbe.intervalMinutes || DEFAULT_PROBE_INTERVAL_MIN) * 60 * 1000;
    const last = state.lastProbeAt ? new Date(state.lastProbeAt).getTime() : 0;
    if (Date.now() - last < intervalMs) return;
    await probeUpstreamModels(env, cfg, 'auto');
}

async function runModelProbeJob(env, source) {
    const cfg = await loadRelayConfig(env);
    if (!cfg.modelProbe?.enabled || !cfg.upstreamApiKey) return;
    await probeUpstreamModels(env, cfg, source);
}

async function probeUpstreamModels(env, cfg, source, options = {}) {
    const force = options.force === true || source === 'manual';
    let state = await loadModelsState(env);

    if (state.probing) {
        if (!force && !isProbeLockStale(state)) {
            return {
                error: '探测正在进行中',
                hint: '约 8 分钟后自动解锁，或点击下方「解除锁定」',
                state,
            };
        }
        await clearProbeLock(env, force ? '手动探测已抢占上次任务' : '上次探测超时，已自动解锁');
        state = await loadModelsState(env);
    }

    const startedAt = new Date().toISOString();
    state.probing = true;
    state.probeStartedAt = startedAt;
    state.lastError = null;
    await saveModelsState(env, state);

    const base = cfg.upstreamBaseUrl.replace(/\/+$/, '');
    const authHdr = { Authorization: `Bearer ${cfg.upstreamApiKey}`, 'Content-Type': 'application/json' };
    const wallStart = Date.now();
    let truncated = false;

    try {
        const listRes = await fetch(`${base}/v1/models`, { headers: authHdr });
        const listJson = await listRes.json().catch(() => ({}));
        if (!listRes.ok) {
            throw new Error(listJson?.error?.message || `拉取模型列表失败: ${listRes.status}`);
        }
        const allModels = (listJson.data || []).filter((m) => m?.id);
        const candidates = pickModelsToTest(allModels, cfg.modelProbe.maxModels);

        const results = [];
        for (let i = 0; i < candidates.length; i += MODEL_PROBE_PARALLEL) {
            if (Date.now() - wallStart > PROBE_WALL_MAX_MS) {
                truncated = true;
                break;
            }
            const batch = candidates.slice(i, i + MODEL_PROBE_PARALLEL);
            const batchResults = await Promise.all(batch.map((m) => testOneModel(base, authHdr, m)));
            results.push(...batchResults);
            const prev = await loadModelsState(env);
            const partialAvailable = results.filter((r) => r.ok).map((r) => r.id);
            const partialModels = allModels.filter((m) => partialAvailable.includes(m.id));
            await saveModelsState(env, {
                ...prev,
                probing: true,
                probeStartedAt: startedAt,
                lastProbeSource: source,
                upstreamBaseUrl: base,
                allCount: allModels.length,
                testedCount: results.length,
                available: partialAvailable,
                models: partialModels.length ? partialModels : buildModelListItems({ available: partialAvailable }),
                results,
            });
        }

        const available = [...new Set(results.filter((r) => r.ok).map((r) => r.id))];
        const modelObjects = allModels.filter((m) => available.includes(m.id));
        const modelsForKv = modelObjects.length
            ? modelObjects
            : buildModelListItems({ available });

        const next = {
            lastProbeAt: new Date().toISOString(),
            lastProbeSource: source,
            upstreamBaseUrl: base,
            probing: false,
            probeStartedAt: null,
            allCount: allModels.length,
            testedCount: results.length,
            plannedCount: candidates.length,
            truncated,
            available,
            models: modelsForKv,
            results,
            lastError: truncated ? '已达单次时间上限，仅完成部分模型实测' : null,
        };
        await saveModelsState(env, next);
        await syncAvailableToRelay(env, available, next.lastProbeAt);
        return {
            success: true,
            lastProbeAt: next.lastProbeAt,
            allCount: next.allCount,
            testedCount: next.testedCount,
            plannedCount: next.plannedCount,
            truncated,
            availableCount: available.length,
            available,
            results,
        };
    } catch (e) {
        const fail = {
            ...(await loadModelsState(env)),
            probing: false,
            probeStartedAt: null,
            lastError: e.message,
            lastProbeAt: new Date().toISOString(),
            lastProbeSource: source,
        };
        await saveModelsState(env, fail);
        return { error: e.message, state: fail };
    }
}

function pickModelsToTest(allModels, max) {
    const scored = allModels.map((m) => ({ m, score: modelTestPriority(m.id) }));
    scored.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const { m, score } of scored) {
        if (score < 0) continue;
        picked.push(m);
        if (picked.length >= max) break;
    }
    return picked;
}

function modelTestPriority(id) {
    const s = id.toLowerCase();
    if (/dall-e|whisper|tts|audio|realtime|transcribe|moderation|davinci-instruct|babbage|curie|ada(?!pt)/i.test(s)) return -1;
    if (/^text-embedding|embed/.test(s)) return 5;
    if (/gpt-4|gpt-3\.5|o1|o3|o4|claude|gemini|deepseek|qwen|llama|mistral|grok/i.test(s)) return 10;
    return 3;
}

function modelTestKind(id) {
    const s = id.toLowerCase();
    if (/^text-embedding|embed/.test(s)) return 'embedding';
    return 'chat';
}

async function testOneModel(base, authHdr, modelObj) {
    const id = modelObj.id;
    const kind = modelTestKind(id);
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MODEL_TEST_TIMEOUT_MS);
    try {
        let res;
        if (kind === 'embedding') {
            res = await fetch(`${base}/v1/embeddings`, {
                method: 'POST',
                headers: authHdr,
                signal: ctrl.signal,
                body: JSON.stringify({ model: id, input: 'ping' }),
            });
        } else {
            res = await fetch(`${base}/v1/chat/completions`, {
                method: 'POST',
                headers: authHdr,
                signal: ctrl.signal,
                body: JSON.stringify({
                    model: id,
                    messages: [{ role: 'user', content: 'hi' }],
                    max_tokens: 1,
                    temperature: 0,
                }),
            });
        }
        const data = await res.json().catch(() => ({}));
        const ok = res.ok && !data?.error;
        return {
            id,
            ok,
            kind,
            status: res.status,
            latencyMs: Date.now() - started,
            error: ok ? null : (data?.error?.message || `HTTP ${res.status}`),
        };
    } catch (e) {
        return {
            id,
            ok: false,
            kind,
            status: 0,
            latencyMs: Date.now() - started,
            error: e.name === 'AbortError' ? 'timeout' : e.message,
        };
    } finally {
        clearTimeout(timer);
    }
}

function normalizeBaseUrl(url) {
    return (url || '').trim().replace(/\/+$/, '').toLowerCase();
}

/** 按 available 构建 OpenAI 标准 models 列表（兼容不在 /v1/models 里的自定义模型 id） */
function buildModelListItems(state) {
    const ids = [...new Set((state.available || []).filter(Boolean))];
    const map = new Map((state.models || []).map((m) => [m.id, m]));
    const now = Math.floor(Date.now() / 1000);
    return ids.map((id) => {
        const m = map.get(id);
        if (m && m.id) {
            return {
                id: m.id,
                object: m.object || 'model',
                created: m.created ?? now,
                owned_by: m.owned_by || 'openai',
            };
        }
        return { id, object: 'model', created: now, owned_by: 'openai' };
    });
}

async function buildFilteredModelsResponse(cfg, env) {
    const state = await getAvailableModelsState(env, cfg);
    let source = 'kv';

    if (state.probing) {
        return { object: 'list', data: [], source: 'probing', _warn: 'probing-in-progress' };
    }

    let data = buildModelListItems(state);
    if (!data.length && (cfg.availableModels || []).length) {
        source = 'relay.json';
        data = buildModelListItems({ available: cfg.availableModels, models: state.models });
    }

    const base = normalizeBaseUrl(cfg.upstreamBaseUrl);
    const probedBase = normalizeBaseUrl(state.upstreamBaseUrl);
    let warn = null;
    if (probedBase && base && probedBase !== base) warn = 'upstream-changed';
    if (!data.length && (state.lastProbeAt || cfg.modelsProbeAt)) warn = warn || 'no-available-models';

    const body = { object: 'list', data, source };
    if (warn) body._warn = warn;
    return body;
}

function openaiJsonResponse(body, status = 200, extraHeaders = {}) {
    const { _warn, source, ...clientBody } = body;
    const headers = {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
        ...extraHeaders,
    };
    return new Response(JSON.stringify(clientBody), { status, headers });
}

function htmlResponse(body, status) {
    return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ─── 页面 ─────────────────────────────────────────────────────────────

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · 融合网络-OpenAI中转</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:system-ui,sans-serif;background:linear-gradient(135deg,#0f172a,#1e293b);color:#e2e8f0}
.card{background:#1e293b;padding:2rem;border-radius:12px;width:min(360px,92vw);box-shadow:0 8px 32px #0006}
h1{font-size:1.25rem;margin:0 0 1rem}input{width:100%;padding:.75rem;border:1px solid #334155;border-radius:8px;
background:#0f172a;color:#fff;margin-bottom:1rem}button{width:100%;padding:.75rem;border:0;border-radius:8px;
background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}button:hover{background:#2563eb}
.err{color:#f87171;font-size:.875rem;margin-top:.5rem;display:none}
</style></head><body><div class="card"><h1>融合网络-OpenAI中转</h1>
<p style="margin:0 0 1rem;font-size:.875rem;color:#94a3b8">管理后台登录</p>
<form id="f"><input type="password" name="password" placeholder="管理密码" required autocomplete="current-password">
<button type="submit">登录</button><p class="err" id="e"></p></form></div>
<script>
document.getElementById('f').onsubmit=async e=>{e.preventDefault();
const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({password:e.target.password.value})});
if(r.ok)location.href='/admin';else{document.getElementById('e').style.display='block';
document.getElementById('e').textContent=(await r.json()).error||'登录失败';}};
</script></body></html>`;

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>管理 · 融合网络-OpenAI中转</title>
<style>
:root{--bg:#0f172a;--card:#1e293b;--border:#334155;--text:#e2e8f0;--muted:#94a3b8;--accent:#3b82f6;--ok:#22c55e;--err:#ef4444}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
header{display:flex;justify-content:space-between;align-items:center;padding:1rem 1.5rem;border-bottom:1px solid var(--border)}
main{max-width:720px;margin:0 auto;padding:1.5rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.25rem;margin-bottom:1rem}
label{display:block;font-size:.8rem;color:var(--muted);margin-bottom:.35rem}
input,textarea{width:100%;padding:.65rem .75rem;border:1px solid var(--border);border-radius:8px;
background:#0f172a;color:var(--text);font-family:ui-monospace,monospace;font-size:.85rem}
.row{margin-bottom:1rem}.hint{font-size:.75rem;color:var(--muted);margin-top:.25rem}
.btns{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem}
button,.link-btn{padding:.55rem 1rem;border-radius:8px;border:0;font-weight:600;cursor:pointer;font-size:.875rem}
.btn-primary{background:var(--accent);color:#fff}.btn-secondary{background:#334155;color:var(--text)}
.btn-danger{background:#7f1d1d;color:#fecaca}a{color:#93c5fd;text-decoration:none}
.snippet{background:#0f172a;padding:.75rem;border-radius:8px;font-size:.8rem;word-break:break-all;margin-top:.5rem}
.toast{position:fixed;bottom:1rem;right:1rem;padding:.75rem 1rem;border-radius:8px;background:#166534;display:none}
.toggle{display:flex;align-items:center;gap:.5rem}
.model-toolbar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-bottom:.75rem}
.model-toolbar input{flex:1;min-width:160px;margin:0}
.model-table{width:100%;border-collapse:collapse;font-size:.8rem}
.model-table th,.model-table td{padding:.45rem .5rem;text-align:left;border-bottom:1px solid var(--border)}
.model-table th{color:var(--muted);font-weight:600}
.model-table tr:hover td{background:#0f172a}
.badge-ok{color:#86efac}.badge-kv{color:#93c5fd;font-size:.7rem}
.probe-log{max-height:180px;overflow:auto;font-size:.75rem;background:#0f172a;padding:.5rem;border-radius:8px;margin:0;white-space:pre-wrap}
.sub-title{font-size:.85rem;font-weight:600;margin:1rem 0 .5rem;color:var(--text)}
</style></head><body>
<header><strong>融合网络-OpenAI中转</strong><a href="/logout">退出</a></header>
<main>
<div class="card"><h2 style="margin:0 0 .75rem;font-size:1rem">客户端连接</h2>
<p class="hint">在 Cursor / OpenAI SDK 中：Base URL 填 <code>…/v1</code>，API Key 填<strong>本地 Token</strong>（支持 Bearer 或 <code>api-key</code> 头）</p>
<div class="snippet" id="snippet">加载中…</div>
<button type="button" class="btn-secondary" onclick="copySnippet()">复制配置说明</button>
</div>
<div class="card">
<div class="row toggle"><input type="checkbox" id="enabled" checked><label for="enabled" style="margin:0">启用中转</label></div>
<div class="row"><label>上游 Base URL（不含 /v1）</label>
<input id="upstreamBaseUrl" placeholder="https://api.openai.com"></div>
<div class="row"><label>上游 API Key（目标 Token，明文）</label>
<input id="upstreamApiKey" type="text" autocomplete="off" placeholder="sk-..."></div>
<div class="row"><label>本地 Token（客户端 apiKey，明文）</label>
<input id="clientToken" type="text" autocomplete="off" placeholder="本地中转用 Token"></div>
<div class="btns">
<button class="btn-primary" onclick="save()">保存配置</button>
<button class="btn-secondary" onclick="testUpstream()">测试上游</button>
<button class="btn-secondary" onclick="regenToken()">重新生成本地 Token</button>
</div>
<p class="hint" id="meta"></p>
</div>
<div class="card">
<h2 style="margin:0 0 .75rem;font-size:1rem">响应缓存（节省 Token）</h2>
<p class="hint">相同请求（非流式）命中 KV 后直接返回，不再调用上游。响应头 <code>X-Proxy-Cache: HIT</code> 表示命中。跳过缓存：请求头 <code>X-Cache-Bypass: 1</code></p>
<div class="row toggle"><input type="checkbox" id="cacheEnabled"><label for="cacheEnabled" style="margin:0">启用缓存</label></div>
<div class="row"><label>TTL（秒，60～604800）</label>
<input id="cacheTtl" type="number" min="60" max="604800" value="86400"></div>
<div class="row toggle"><input type="checkbox" id="cacheChat" checked><label for="cacheChat" style="margin:0">缓存 chat/completions</label></div>
<div class="row toggle"><input type="checkbox" id="cacheEmbed" checked><label for="cacheEmbed" style="margin:0">缓存 embeddings</label></div>
<div class="row toggle"><input type="checkbox" id="cacheOnlyTemp0"><label for="cacheOnlyTemp0" style="margin:0">仅 temperature=0 时缓存（更保守）</label></div>
<p class="hint" id="cacheStats">统计加载中…</p>
<div class="btns">
<button class="btn-secondary" onclick="clearCache()">清空全部缓存</button>
</div>
</div>
<div class="card">
<h2 style="margin:0 0 .75rem;font-size:1rem">模型探测</h2>
<p class="hint">定时拉取上游 /v1/models 并实测可用性；客户端 GET /v1/models 仅返回可用模型。Cron: <code>*/30 * * * *</code></p>
<div class="row toggle"><input type="checkbox" id="probeEnabled" checked><label for="probeEnabled" style="margin:0">启用定时探测</label></div>
<div class="row toggle"><input type="checkbox" id="probeFilter" checked><label for="probeFilter" style="margin:0">中转仅展示可用模型</label></div>
<div class="row toggle"><input type="checkbox" id="probeBlock"><label for="probeBlock" style="margin:0">拒绝不可用模型的对话请求</label></div>
<div class="row"><label>探测间隔（分钟，默认 30）</label>
<input id="probeInterval" type="number" min="5" max="1440" value="30"></div>
<p class="hint" id="modelProbeMeta">—</p>
<div class="sub-title">KV 可用模型（<span id="kvStoreKey">models_state.json</span> · <span id="availableCount">0</span> 个）</div>
<div class="model-toolbar">
<input type="search" id="modelSearch" placeholder="搜索模型 ID…" oninput="filterModelTable()">
<button type="button" class="btn-secondary" onclick="copyAvailableModels()">复制全部 ID</button>
</div>
<div style="overflow:auto;max-height:280px;border:1px solid var(--border);border-radius:8px">
<table class="model-table"><thead><tr><th>#</th><th>模型 ID</th><th>延迟</th><th></th></tr></thead>
<tbody id="availableModelTable"><tr><td colspan="4">加载中…</td></tr></tbody></table>
</div>
<p class="hint" id="relayStoreHint">relay.json 备份：—</p>
<div class="sub-title">探测明细（通过 / 失败）</div>
<pre class="probe-log" id="modelList">加载中…</pre>
<div class="btns">
<button class="btn-secondary" onclick="probeModelsNow()">立即探测</button>
<button class="btn-secondary" onclick="unlockProbe()">解除锁定</button>
<button class="btn-secondary" onclick="syncModels()">同步到中转配置</button>
</div>
</div>
</main>
<div class="toast" id="toast"></div>
<script>
const ORIGIN='{{ORIGIN}}';
function toast(m,err){const t=document.getElementById('toast');t.textContent=m;t.style.background=err?'#991b1b':'#166534';t.style.display='block';setTimeout(()=>t.style.display='none',3000)}
async function load(){
const r=await fetch('/admin/api/config');const c=await r.json();
document.getElementById('upstreamBaseUrl').value=c.upstreamBaseUrl||'';
document.getElementById('upstreamApiKey').value=c.upstreamApiKey||'';
document.getElementById('clientToken').value=c.clientToken||'';
document.getElementById('enabled').checked=c.enabled!==false;
const ch=c.cache||{};
document.getElementById('cacheEnabled').checked=!!ch.enabled;
document.getElementById('cacheTtl').value=ch.ttlSeconds||86400;
document.getElementById('cacheChat').checked=ch.chatCompletions!==false;
document.getElementById('cacheEmbed').checked=ch.embeddings!==false;
document.getElementById('cacheOnlyTemp0').checked=!!ch.onlyTemperatureZero;
const st=c.cacheStats||{};
document.getElementById('cacheStats').textContent='命中 '+ (st.hits||0)+' · 未命中 '+ (st.misses||0)+' · 已写入 '+ (st.saved||0);
document.getElementById('meta').textContent='更新: '+(c.updatedAt||'—')+(c.hasKv===false?' · 警告: 未绑定 KV，配置重启后可能丢失':'');
updateSnippet(c);
fetch('/admin/api/cache/stats').then(r=>r.json()).then(s=>{
document.getElementById('cacheStats').textContent='命中 '+ (s.cacheStats?.hits||0)+' · 未命中 '+ (s.cacheStats?.misses||0)+' · KV条目 '+ (s.entries||0);
}).catch(()=>{});
const mp=c.modelProbe||{};
document.getElementById('probeEnabled').checked=mp.enabled!==false;
document.getElementById('probeFilter').checked=mp.filterModels!==false;
document.getElementById('probeBlock').checked=!!mp.blockUnavailable;
document.getElementById('probeInterval').value=mp.intervalMinutes||30;
loadModelsPanel();
}
let _availableModels=[];
async function loadModelsPanel(){
const r=await fetch('/admin/api/models');const j=await r.json();
const m=j.models||{};
const kv=j.kvStore||{};
const relay=j.relayStore||{};
const lock=m.probing?' · 进行中':'';
document.getElementById('modelProbeMeta').textContent='上次: '+(m.lastProbeAt||'从未')+' · 来源: '+(m.lastProbeSource||'—')+' · 上游 '+ (m.allCount||0)+' 个，实测 '+(m.testedCount||0)+(m.plannedCount?'/'+m.plannedCount:'')+'，KV可用 '+(kv.availableCount||0)+lock+(m.lastError?' · '+m.lastError:'')+(j.clientPreview?' · 客户端 '+j.clientPreview.count+' 个':'');
document.getElementById('kvStoreKey').textContent=kv.key||'models_state.json';
document.getElementById('availableCount').textContent=kv.availableCount||0;
document.getElementById('relayStoreHint').textContent='relay.json.'+(relay.field||'availableModels')+'：'+(relay.availableIds?.length||0)+' 个'+(relay.modelsProbeAt?' · 更新 '+relay.modelsProbeAt:'');
_availableModels=j.availableDetail||kv.availableIds?.map(id=>({id}))||[];
renderAvailableTable(_availableModels);
const lines=(m.results||[]).map(x=>(x.ok?'✓':'✗')+' '+x.id+' '+(x.latencyMs||'-')+'ms'+(x.error?' '+x.error:''));
document.getElementById('modelList').textContent=lines.length?lines.join('\\n'):'(暂无探测记录)';
}
function renderAvailableTable(list){
const q=(document.getElementById('modelSearch').value||'').trim().toLowerCase();
const filtered=list.filter(x=>!q||x.id.toLowerCase().includes(q));
const tb=document.getElementById('availableModelTable');
if(!filtered.length){tb.innerHTML='<tr><td colspan="4" style="color:var(--muted)">'+(list.length?'无匹配':'KV 中暂无可用模型，请先探测')+'</td></tr>';return;}
tb.innerHTML=filtered.map((x,i)=>'<tr><td>'+(i+1)+'</td><td><code>'+escHtml(x.id)+'</code></td><td class="badge-ok">'+(x.latencyMs!=null?x.latencyMs+'ms':'—')+'</td><td><button type="button" class="btn-secondary" style="padding:.2rem .5rem;font-size:.7rem" onclick="copyOneModel(\\''+escAttr(x.id)+'\\')">复制</button></td></tr>').join('');
}
function filterModelTable(){renderAvailableTable(_availableModels);}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function escAttr(s){return String(s).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'");}
function copyOneModel(id){navigator.clipboard.writeText(id);toast('已复制: '+id);}
function copyAvailableModels(){
const ids=_availableModels.map(x=>x.id);
if(!ids.length){toast('无可用模型',1);return;}
navigator.clipboard.writeText(ids.join('\\n'));toast('已复制 '+ids.length+' 个模型 ID');}
function updateSnippet(c){
const base=c.clientBaseUrl||ORIGIN+'/v1';
const tok=c.clientToken||'(未设置)';
document.getElementById('snippet').innerHTML='Base URL: <code>'+base+'</code><br>API Key: <code>'+tok+'</code><br><br>Python:<br><code>OpenAI(base_url="'+base+'", api_key="'+tok+'")</code>';
window._snippetText='Base URL: '+base+'\\nAPI Key: '+tok;
}
function copySnippet(){navigator.clipboard.writeText(window._snippetText||'');toast('已复制');}
async function save(){
const body={upstreamBaseUrl:document.getElementById('upstreamBaseUrl').value,enabled:document.getElementById('enabled').checked,
upstreamApiKey:document.getElementById('upstreamApiKey').value.trim(),
clientToken:document.getElementById('clientToken').value.trim(),
cache:{enabled:document.getElementById('cacheEnabled').checked,
ttlSeconds:parseInt(document.getElementById('cacheTtl').value,10)||86400,
chatCompletions:document.getElementById('cacheChat').checked,
embeddings:document.getElementById('cacheEmbed').checked,
onlyTemperatureZero:document.getElementById('cacheOnlyTemp0').checked},
modelProbe:{enabled:document.getElementById('probeEnabled').checked,
filterModels:document.getElementById('probeFilter').checked,
blockUnavailable:document.getElementById('probeBlock').checked,
intervalMinutes:parseInt(document.getElementById('probeInterval').value,10)||30}};
const r=await fetch('/admin/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const j=await r.json();if(j.success){toast('已保存');load();}else toast(j.error||'保存失败',1);
}
async function testUpstream(){const r=await fetch('/admin/api/test',{method:'POST'});
const j=await r.json();toast(j.success?'上游连接成功':'失败: '+(j.error||j.status),!j.success);}
async function regenToken(){if(!confirm('将替换本地 Token，旧客户端需更新 apiKey'))return;
const r=await fetch('/admin/api/regen-token',{method:'POST'});const j=await r.json();
if(j.success){document.getElementById('clientToken').value=j.clientToken;toast('已生成新 Token');load();}}
async function clearCache(){if(!confirm('确定清空所有响应缓存？'))return;
const r=await fetch('/admin/api/cache/clear',{method:'POST'});const j=await r.json();
toast(j.success?'已删除 '+j.deleted+' 条':'失败',!j.success);load();}
async function probeModelsNow(){
document.getElementById('availableModelTable').innerHTML='<tr><td colspan="4">探测中…</td></tr>';
document.getElementById('modelList').textContent='探测中，请稍候…';
const r=await fetch('/admin/api/models/probe',{method:'POST'});
const j=await r.json();
toast(j.success?'可用 '+ (j.availableCount||0)+' / '+ (j.testedCount||0)+(j.truncated?'（部分）':''):'失败: '+(j.error||j.hint||''),!j.success);
load();}
async function unlockProbe(){
const r=await fetch('/admin/api/models/unlock',{method:'POST'});const j=await r.json();
toast(j.success?'已解除锁定':'失败',!j.success);load();}
async function syncModels(){
const r=await fetch('/admin/api/models/sync',{method:'POST'});const j=await r.json();
toast(j.success?'已同步 '+j.count+' 个模型到中转':'失败: '+(j.error||''),!j.success);load();}
load();
</script></body></html>`;
