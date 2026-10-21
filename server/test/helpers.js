// 测试辅助：重置测试库、启动服务、带会话 cookie 的请求封装。
// 测试库名由环境变量 MONGODB_DB 决定（package.json 的 test 脚本配合各测试文件顶部设置）。
const { MongoClient } = require('mongodb');
const { start, close } = require('../src/app');

const TEST_DB = process.env.MONGODB_DB || 'survey_system_test';
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';

async function resetTestDb() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  await client.db(TEST_DB).dropDatabase();
  await client.close();
}

async function startServer() {
  const { server, port } = await start(0);
  return { server, port, base: `http://127.0.0.1:${port}` };
}

async function stopServer(ctx) {
  if (ctx && ctx.server) await new Promise((resolve) => ctx.server.close(resolve));
  await close();
}

// fetch 封装：手动维护会话 cookie（Node 原生 fetch 不带 cookie jar）
async function req(base, path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  const hasBody = body !== undefined && body !== null;
  if (hasBody) headers['content-type'] = 'application/json';
  if (cookie) headers['cookie'] = cookie;
  const res = await fetch(base + path, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const cookieStr = setCookies.map((c) => c.split(';')[0]).join('; ');
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, data, cookie: cookieStr || cookie || '' };
}

// 注册并登录，返回会话 cookie
async function registerAndLogin(base, username, password = 'secret123') {
  await req(base, '/api/auth/register', { method: 'POST', body: { username, password } });
  const login = await req(base, '/api/auth/login', { method: 'POST', body: { username, password } });
  return login.cookie;
}

module.exports = { resetTestDb, startServer, stopServer, req, registerAndLogin, TEST_DB };
