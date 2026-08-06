// Firefly-Markdown 后端：GitHub OAuth 登录 + Contents API 代理 ）
// 技术栈：Cloudflare Workers + Hono + D1 
// 设计：纯前端不再直接接触 GitHub token；浏览器持「会话令牌」访问本后端，
//       后端用服务端持有的 GitHub OAuth token 代理 api.github.com。

import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

// ---------- CORS ----------
// 允许的前端源来自 env.FRONTEND_ORIGIN（逗号分隔）；浏览器用 Bearer 令牌，无需凭据 cookie。
app.use('/api/*', cors({
  origin: (origin, c) => {
    const allowed = (c.env.FRONTEND_ORIGIN || 'http://localhost:8123')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (!origin) return allowed[0] || '*';
    return allowed.includes(origin) ? origin : (allowed[0] || '*');
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-GitHub-Api-Version'],
  maxAge: 600,
}));

// ---------- 加解密（Web Crypto AES-GCM）----------
const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(secret) {
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function aesEncrypt(plain, secret) {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return [...out].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function aesDecrypt(hex, secret) {
  const bytes = new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16)));
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const key = await deriveKey(secret);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return dec.decode(pt);
}
function randToken(n = 32) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- 鉴权 ----------
async function authUser(c) {
  const auth = c.req.header('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1];
  const row = await c.env.DB.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>?')
    .bind(token, Date.now()).first();
  if (!row) return null;
  try { row.github_token = await aesDecrypt(row.github_token, c.env.SESSION_SECRET); }
  catch (e) { return null; }
  return row;
}

// ---------- 路由 ----------
app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }));

// 1) 发起 GitHub OAuth：重定向到 GitHub 授权页
app.get('/api/auth/login', async (c) => {
  const fallback = (c.env.FRONTEND_ORIGIN || 'http://localhost:8123').split(',')[0].trim();
  const redirect = c.req.query('redirect') || fallback;
  const state = randToken(16);
  await c.env.DB.prepare('INSERT OR REPLACE INTO oauth_states (state, expires_at) VALUES (?, ?)')
    .bind(state, Date.now() + 10 * 60 * 1000).run();
  const clientId = c.env.GITHUB_CLIENT_ID;
  const callback = new URL('/api/auth/callback', new URL(c.req.url)).href;
  const ghUrl = 'https://github.com/login/oauth/authorize?client_id=' +
    encodeURIComponent(clientId) + '&redirect_uri=' + encodeURIComponent(callback) +
    '&scope=' + encodeURIComponent('repo') + '&state=' + state + '&allow_signup=false';
  return c.redirect(ghUrl);
});

// 2) GitHub 回调：换 token → 取用户 → 建会话 → 重定向回前端（带 token+login）
app.get('/api/auth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const fallback = (c.env.FRONTEND_ORIGIN || 'http://localhost:8123').split(',')[0].trim();
  const redirect = c.req.query('redirect') || fallback;

  const st = await c.env.DB.prepare('SELECT * FROM oauth_states WHERE state=?').bind(state).first();
  if (!st || st.expires_at < Date.now()) return c.text('invalid or expired state', 400);
  await c.env.DB.prepare('DELETE FROM oauth_states WHERE state=?').bind(state).run();
  if (!code) return c.text('missing code', 400);

  const clientId = c.env.GITHUB_CLIENT_ID;
  const clientSecret = c.env.GITHUB_CLIENT_SECRET;
  const callback = new URL('/api/auth/callback', new URL(c.req.url)).href;
  const tkRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callback })
  });
  const tk = await tkRes.json();
  if (!tk.access_token) return c.text('token exchange failed: ' + (tk.error_description || ''), 400);

  const uRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: 'Bearer ' + tk.access_token, Accept: 'application/vnd.github+json', 'User-Agent': 'firefly-markdown' }
  });
  const user = await uRes.json();

  const token = randToken(32);
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const encTok = await aesEncrypt(tk.access_token, c.env.SESSION_SECRET);
  await c.env.DB.prepare('INSERT OR REPLACE INTO sessions (token, github_login, github_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(token, user.login, encTok, Date.now(), expires).run();

  const back = new URL(redirect);
  back.searchParams.set('token', token);
  back.searchParams.set('login', user.login);
  return c.redirect(back.href);
});

// 3) 当前登录态
app.get('/api/auth/me', async (c) => {
  const u = await authUser(c);
  if (!u) return c.json({ authed: false });
  return c.json({ authed: true, login: u.github_login });
});

// 4) 登出
app.post('/api/auth/logout', async (c) => {
  const u = await authUser(c);
  if (u) await c.env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(u.token).run();
  return c.json({ ok: true });
});

// 5) GitHub API 代理：前端用 Bearer 会话令牌访问，后端注入 GitHub token 转发
app.all('/api/github/*', async (c) => {
  const u = await authUser(c);
  if (!u) return c.json({ error: 'unauthorized' }, 401);
  const sub = c.req.path.replace(/^\/api\/github/, '');
  const q = new URL(c.req.url).search;
  const url = 'https://api.github.com' + sub + (q || '');
  const method = c.req.method;
  let body;
  if (method !== 'GET' && method !== 'HEAD') { try { body = await c.req.text(); } catch (e) {} }
  const headers = {
    Authorization: 'Bearer ' + u.github_token,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'firefly-markdown',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const ct = c.req.header('Content-Type');
  if (ct) headers['Content-Type'] = ct;
  const res = await fetch(url, { method, headers, body });
  const respText = await res.text();
  return new Response(respText, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' }
  });
});

export default app;
