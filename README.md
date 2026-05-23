# 融合网络 · OpenAI 中转

基于 [Cloudflare Workers](https://developers.cloudflare.com/workers/) 的 **OpenAI 兼容 API 中转**服务：隐藏上游真实 Key、Web 管理配置、模型可用性探测、响应缓存省 Token。适用于 Cursor、OpenAI SDK、通义千问（DashScope 兼容模式）、OpenRouter、NVIDIA API 等所有支持 OpenAI 协议的上游。

```
客户端  ──(本地 Token)──►  Worker /v1/*  ──(上游 Key)──►  上游 API
              ▲                    │
              │              KV 配置 / 缓存 / 模型探测
         管理后台 /admin
```

## 功能特性

| 功能 | 说明 |
|------|------|
| **标准协议** | 透传 `/v1/chat/completions`、`/v1/embeddings`、`/v1/models` 等 |
| **双 Token** | 客户端使用「本地 Token」，Worker 替换为「上游 API Key」 |
| **鉴权兼容** | 支持 `Authorization: Bearer` 与 `api-key`（Cursor 常用） |
| **Web 管理** | `/admin` 配置上游地址、Key、缓存、模型探测 |
| **模型探测** | 拉取上游模型列表并实测，仅向客户端返回可用模型 |
| **定时探测** | 默认每 30 分钟 Cron 自动更新（可配置） |
| **KV 缓存** | 相同非流式请求命中缓存，减少上游 Token 消耗 |
| **流式支持** | `stream: true` 原样透传，不缓冲 |

## 快速开始

### 1. 前置要求

- [Cloudflare](https://dash.cloudflare.com/) 账号
- [Node.js](https://nodejs.org/) 18+（用于 Wrangler CLI）
- 一个已接入 Cloudflare 的域名（可选，也可使用 `*.workers.dev`）

### 2. 创建 KV

```bash
npx wrangler kv namespace create RELAY_KV
```

记下返回的 `id`，填入 `wrangler-relay.toml`。

### 3. 配置 Wrangler

编辑 [`wrangler-relay.toml`](wrangler-relay.toml)：

```toml
name = "openai-relay"
main = "worker_openai.js"
compatibility_date = "2024-08-01"

[[kv_namespaces]]
binding = "KV"
id = "你的_KV_namespace_id"

[triggers]
crons = ["*/30 * * * *"]
```

### 4. 设置环境变量

在 Cloudflare 控制台 → Worker → 设置 → 变量，或使用 CLI：

```bash
npx wrangler secret put PASSWORD          # 管理后台登录密码（必填）
npx wrangler secret put OPENAI_API_KEY    # 上游 API Key（可选，也可在后台填）
```

| 变量 | 必填 | 说明 |
|------|------|------|
| `PASSWORD` | 是 | 管理后台 `/admin` 登录密码 |
| `KEY` | 否 | Cookie 加盐字符串 |
| `OPENAI_BASE_URL` | 否 | 初始上游根地址（不含 `/v1`） |
| `OPENAI_API_KEY` | 否 | 初始上游 Key |
| `PROXY_SECRET` | 否 | 初始本地 Token（可在后台重新生成） |

### 5. 部署

```bash
npx wrangler deploy -c wrangler-relay.toml
```

部署后访问：

- 管理后台：`https://你的域名/admin`
- 登录页：`https://你的域名/login`
- API 基址：`https://你的域名/v1`

## 客户端配置

### Cursor / ChatBox / 任意 OpenAI 兼容工具

| 配置项 | 值 |
|--------|-----|
| **Base URL** | `https://你的域名/v1`（必须有 `/v1`） |
| **API Key** | 管理后台中的 **本地 Token**（`sk-relay-...`） |

> 切勿将上游真实 Key 填入客户端。

### Python（OpenAI SDK）

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://你的域名/v1",
    api_key="你的本地Token",
)

resp = client.chat.completions.create(
    model="gpt-4o-mini",  # 或千问 qwen-plus 等
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

### cURL 测试

```bash
# 模型列表（过滤后）
curl "https://你的域名/v1/models" \
  -H "api-key: 你的本地Token"

# 对话
curl "https://你的域名/v1/chat/completions" \
  -H "api-key: 你的本地Token" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"hi"}],"max_tokens":32}'
```

## 上游配置示例

在管理后台填写 **上游 Base URL**（不要带 `/v1`）和 **上游 API Key**。

| 服务商 | 上游 Base URL |
|--------|----------------|
| OpenAI 官方 | `https://api.openai.com` |
| 通义千问（DashScope） | `https://dashscope.aliyuncs.com/compatible-mode` |
| 通义千问（国际） | `https://dashscope-intl.aliyuncs.com/compatible-mode` |
| OpenRouter | `https://openrouter.ai/api` |
| NVIDIA | `https://integrate.api.nvidia.com` |
| 自建 One-API / New API | 填你的 OpenAI 兼容根地址 |

保存后点击 **测试上游**、**立即探测**，在 KV 可用模型表格中确认列表。

## 管理后台

登录 `/admin` 后可配置：

- **中转开关**、上游 URL / Key、本地 Token（明文展示，可复制）
- **响应缓存**：TTL、chat/embeddings、仅 `temperature=0` 缓存等
- **模型探测**：间隔（默认 30 分钟）、仅展示可用模型、拒绝不可用模型
- **KV 可用模型列表**：搜索、复制、探测明细
- **同步到中转配置**：将探测结果写入 `relay.json`

## API 路由

| 路径 | 说明 |
|------|------|
| `GET/POST /v1/*` | OpenAI 兼容 API（需本地 Token） |
| `GET /health` | 健康检查 |
| `GET /admin` | Web 管理（需 `PASSWORD`） |
| `POST /login` | 管理登录 |
| `GET /logout` | 退出登录 |

### 响应头（调试）

| 头 | 含义 |
|----|------|
| `X-Proxy-Cache: HIT` | KV 缓存命中 |
| `X-Proxy-Models: filtered` | 模型列表已过滤为可用模型 |
| `X-Proxy-Models-Count` | 返回模型数量 |

### 跳过缓存 / 获取全量模型

```http
X-Cache-Bypass: 1
GET /v1/models?all_models=1
X-Models-All: 1
```

## KV 存储说明

| 键名 | 内容 |
|------|------|
| `relay.json` | 中转主配置（上游、本地 Token、缓存、探测设置） |
| `models_state.json` | 模型探测结果（可用列表、探测明细） |
| `ocache:*` | 响应缓存条目 |

## 项目结构

```
.
├── worker_openai.js      # 主程序（Worker 入口）
├── wrangler-relay.toml   # Wrangler 部署配置
├── worker.js             # 同仓库其他 Worker（VLESS/订阅等，独立项目）
├── config.yaml           # Clash 配置（与中转无关）
└── README.md
```

本仓库 **OpenAI 中转** 仅需关注 `worker_openai.js` 与 `wrangler-relay.toml`。

## 安全建议

- **切勿**将上游 API Key 提交到 Git 或发给客户端
- 为 `PASSWORD` 与本地 Token 使用强随机字符串
- 管理后台仅通过 HTTPS 访问，不要暴露在无密码的公网环境之外
- 本地 Token 泄露后，在后台 **重新生成本地 Token** 并更新客户端
- 生产环境建议在 Cloudflare 配置 WAF / 速率限制

## 常见问题

**Q: Cursor 拉不到模型列表？**  
A: 确认 Base URL 为 `https://域名/v1`；API Key 填本地 Token；部署版本需支持 `api-key` 请求头。

**Q: 探测显示可用但客户端为空？**  
A: 重新部署后点击 **同步到中转配置**；确认已勾选「中转仅展示可用模型」且探测已完成。

**Q: 流式对话能用吗？**  
A: 支持，`stream: true` 直接透传，不走 KV 缓存。

**Q: 和 KV 缓存、CDN 缓存区别？**  
A: KV 缓存按请求体去重，**节省上游 Token**；CDN 适合缓存 `GET /v1/models` 等只读接口，本项目默认未启用 CDN，可按需自行扩展 Cache API。

## 参考链接

- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [OpenAI API 参考](https://platform.openai.com/docs/api-reference)
- [DashScope 兼容模式](https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope)

## 许可证

MIT License — 见 [LICENSE](LICENSE)（若未包含可自行添加）。

## 免责声明

本项目仅供学习与自建代理使用。请遵守上游服务商条款与当地法律法规，不得用于未授权访问或滥用 API。作者不对使用本代码造成的任何费用、封禁或数据损失负责。
