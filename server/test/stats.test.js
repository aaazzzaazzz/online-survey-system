// 统计测试：单选各选项人数、该题回答人数、总答卷数（基于真实答卷聚合）。
process.env.MONGODB_DB = 'survey_system_test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let ctx;
let ownerCookie, u1Cookie, u2Cookie, u3Cookie, otherCookie;
let surveyId, questionId, optionIds;

before(async () => {
  await h.resetTestDb();
  ctx = await h.startServer();
  ownerCookie = await h.registerAndLogin(ctx.base, 'owners');
  u1Cookie = await h.registerAndLogin(ctx.base, 'user1');
  u2Cookie = await h.registerAndLogin(ctx.base, 'user2');
  u3Cookie = await h.registerAndLogin(ctx.base, 'user3');
  otherCookie = await h.registerAndLogin(ctx.base, 'stranger');

  const created = await h.req(ctx.base, '/api/surveys', {
    method: 'POST', cookie: ownerCookie,
    body: { title: '颜色偏好调查', description: '', allowAnonymous: false, allowRepeat: false },
  });
  surveyId = created.data.id;
  await h.req(ctx.base, `/api/surveys/${surveyId}/questions`, {
    method: 'POST', cookie: ownerCookie,
    body: { type: 'single', title: '你喜欢的颜色', required: true, options: ['红', '蓝', '绿'] },
  });
  const detail = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie: ownerCookie });
  const q = detail.data.questions[0];
  questionId = q.id;
  optionIds = q.options.map((o) => o.id);
  await h.req(ctx.base, `/api/surveys/${surveyId}/publish`, { method: 'POST', cookie: ownerCookie });
});

after(async () => { await h.stopServer(ctx); });

async function submit(cookie, optionId) {
  return h.req(ctx.base, `/api/fill/${surveyId}/submit`, {
    method: 'POST', cookie, body: { answers: [{ questionId, value: optionId }] },
  });
}

test('单选统计：各选项选择人数与回答人数（真实答卷聚合）', async () => {
  // user1 红、user2 红、user3 蓝
  assert.equal((await submit(u1Cookie, optionIds[0])).status, 201);
  assert.equal((await submit(u2Cookie, optionIds[0])).status, 201);
  assert.equal((await submit(u3Cookie, optionIds[1])).status, 201);

  const r = await h.req(ctx.base, `/api/stats/${surveyId}`, { cookie: ownerCookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.totalResponses, 3);

  const q = r.data.questions[0];
  assert.equal(q.answered, 3);
  const counts = Object.fromEntries(q.optionCounts.map((o) => [o.label, o.count]));
  assert.deepEqual(counts, { 红: 2, 蓝: 1, 绿: 0 });
});

test('无答卷的问卷：计数全为 0', async () => {
  const created = await h.req(ctx.base, '/api/surveys', {
    method: 'POST', cookie: ownerCookie,
    body: { title: '空问卷', description: '', allowAnonymous: false, allowRepeat: false },
  });
  const id2 = created.data.id;
  await h.req(ctx.base, `/api/surveys/${id2}/questions`, {
    method: 'POST', cookie: ownerCookie,
    body: { type: 'single', title: '题', required: false, options: ['A', 'B'] },
  });
  await h.req(ctx.base, `/api/surveys/${id2}/publish`, { method: 'POST', cookie: ownerCookie });

  const r = await h.req(ctx.base, `/api/stats/${id2}`, { cookie: ownerCookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.totalResponses, 0);
  assert.equal(r.data.questions[0].answered, 0);
  assert.ok(r.data.questions[0].optionCounts.every((o) => o.count === 0));
});

test('他人无法查看统计', async () => {
  const r = await h.req(ctx.base, `/api/stats/${surveyId}`, { cookie: otherCookie });
  assert.equal(r.status, 404);
});
