// 认证测试：注册 / 登录 / 会话 / 规则（Q9）/ 未登录拦截。
// 前置：本地 MongoDB 已启动（见 docs/runbook.md）。
process.env.MONGODB_DB = 'survey_system_test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let ctx;

before(async () => {
  await h.resetTestDb();
  ctx = await h.startServer();
});
after(async () => { await h.stopServer(ctx); });

test('注册 → 登录 → 获取当前用户', async () => {
  const r1 = await h.req(ctx.base, '/api/auth/register', { method: 'POST', body: { username: 'alice', password: 'secret1' } });
  assert.equal(r1.status, 201);
  assert.equal(r1.data.username, 'alice');

  const r2 = await h.req(ctx.base, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'secret1' } });
  assert.equal(r2.status, 200);
  assert.ok(r2.cookie, '登录应下发会话 cookie');

  const me = await h.req(ctx.base, '/api/auth/me', { cookie: r2.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.username, 'alice');
});

test('密码以 bcrypt 哈希存储，不存明文（数据库层面验证）', async () => {
  const { getDb } = require('../src/db');
  const user = await getDb().collection('users').findOne({ username: 'alice' });
  assert.ok(user, '用户应存在于测试库');
  assert.notEqual(user.passwordHash, 'secret1');
  assert.match(user.passwordHash, /^\$2/, '应为 bcrypt 哈希');
  assert.ok(user.createdAt instanceof Date, '应记录注册时间');
});

test('用户名/密码规则（Q9）：长度、空白、密码最短长度', async () => {
  const short = await h.req(ctx.base, '/api/auth/register', { method: 'POST', body: { username: 'ab', password: 'secret1' } });
  assert.equal(short.status, 400);

  const blank = await h.req(ctx.base, '/api/auth/register', { method: 'POST', body: { username: 'a b c', password: 'secret1' } });
  assert.equal(blank.status, 400);

  const weak = await h.req(ctx.base, '/api/auth/register', { method: 'POST', body: { username: 'carol', password: '12345' } });
  assert.equal(weak.status, 400);
});

test('用户名重复注册 → 409', async () => {
  const dup = await h.req(ctx.base, '/api/auth/register', { method: 'POST', body: { username: 'alice', password: 'secret1' } });
  assert.equal(dup.status, 409);
});

test('密码错误登录 → 401', async () => {
  const bad = await h.req(ctx.base, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'wrong-pass' } });
  assert.equal(bad.status, 401);
});

test('未登录访问业务接口 → 401', async () => {
  for (const path of ['/api/surveys', '/api/surveys/abc', '/api/fill/abc', '/api/stats/abc']) {
    const r = await h.req(ctx.base, path);
    assert.equal(r.status, 401, `${path} 应要求登录`);
  }
});
