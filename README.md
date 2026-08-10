# Firefly-Markdown 后端（Cloudflare Workers + Hono）

Firefly-Markdown 的**可选后端**：把 GitHub 鉴权从「用户自建 PAT」升级为「服务端 OAuth 代理」。
前端仍是零依赖纯前端；启用服务器模式后，浏览器不再直接接触 GitHub token，
改为持有一个「会话令牌」访问本后端，由后端用服务端持有的 GitHub OAuth token 代理 `api.github.com`。

> 纯前端 PAT 直连模式**仍然保留**作为 fallback：前端「后端地址」留空时自动走 PAT 直连。

## 架构

```
浏览器(Firefly-Markdown 前端)
   │  Bearer <会话令牌>
   ▼
Cloudflare Worker (Hono)  ── D1(sessions / site_config)
   │  Bearer <GitHub OAuth token>（服务端持有，加密存 D1）
   ▼
api.github.com  (Contents API：读/写/删文章，保存即提交)
```

## 能力

- `GET  /api/health` — 健康检查
- `GET  /api/auth/login?redirect=<前端回跳地址>` — 重定向到 GitHub 授权页
- `GET  /api/auth/callback?code&state&redirect` — 换 token、建会话、重定向回前端（带 `?token=&login=`）
- `GET  /api/auth/me` — 返回当前登录态（需 Bearer 会话令牌）
- `POST /api/auth/logout` — 注销会话
- `ALL  /api/github/*` — 转发到 `https://api.github.com/*`（需 Bearer 会话令牌），前端 publish/pull/delete 全部经此代理

会话令牌用 `SESSION_SECRET`（AES-GCM）加密后存 D1，前端只用不透明的会话令牌。

## 部署步骤

### 1) 创建 GitHub OAuth App
GitHub → Settings → Developer settings → OAuth Apps → New OAuth App：
- **Homepage URL**：你的前端地址（如 `https://your-blog.vercel.app`）
- **Authorization callback URL**：后端回调地址，例如
  `https://firefly-markdown-api.your-subdomain.workers.dev/api/auth/callback`
  （必须与此仓库实际部署域名完全一致，含 `https://` 与 `/api/auth/callback`）
- 创建后拿到 **Client ID** 与 **Client Secret**（后者仅出现一次，妥善保存）。

OAuth App 默认授予对**自己账号**仓库的访问；若要操作组织仓库，需组织批准该 OAuth App。

### 2) 创建并配置 Workers 资源
```bash
cd worker
npm install                # 安装 hono + wrangler
npx wrangler d1 create fmd-db
# 把 d1 create 输出的 database_id 填入 wrangler.toml 的 database_id
# 把 GITHUB_CLIENT_ID 填入 wrangler.toml 的 [vars]
npx wrangler secret put GITHUB_CLIENT_SECRET   # 粘贴 OAuth App 的 client secret
npx wrangler secret put SESSION_SECRET          # 任意长随机串，例如 `openssl rand -hex 32`
```

### 3) 建表（D1）
```bash
npx wrangler d1 execute fmd-db --local  --file=./migrations/0001_init.sql
npx wrangler d1 execute fmd-db --remote --file=./migrations/0001_init.sql
```

### 4) 本地联调 / 部署
```bash
npx wrangler dev          # 本地 http://localhost:8787，前端 backend 填该地址（wrangler dev 含 D1 本地）
npx wrangler deploy       # 部署到生产
```

### 5) 前端配置
打开 Firefly-Markdown → GitHub 同步弹窗 → 「服务器模式」：
- **后端地址** 填 `https://<你的 worker 子域>/`（如 `https://firefly-markdown-api.your-subdomain.workers.dev`）
- 点「使用 GitHub 登录」→ 跳转 GitHub 授权 → 授权后自动回跳并登录
- 之后发布/拉取/删除均经后端代理，无需自建 PAT

## 安全与运维提示
- `GITHUB_CLIENT_SECRET` / `SESSION_SECRET` 必须走 `wrangler secret`，**不要**写进 `wrangler.toml` 或提交仓库。
- `SESSION_SECRET` 泄露等于可解密存储的 GitHub token；轮换后旧会话失效（D1 中会话仍在，但无法解密）。
- 生产环境把 `wrangler.toml` 的 `FRONTEND_ORIGIN` 收紧为你的真实前端域名（逗号分隔可允许多个）。
- OAuth App 的回调地址必须与部署域名完全一致，否则 GitHub 拒绝授权。
- 本后端目前仅做「代理 + 会话」，不做多用户隔离/配额；如需多作者，可在 `sessions`/`site_config` 之上扩展。

## 后续里程碑（已在路线中）
- 站点配置：社交链接/友链存 `site_config`，面板内直接改（不再碰 `src/config/*.ts`）。
