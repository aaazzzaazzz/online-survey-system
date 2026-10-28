// 题库管理测试：创建/列表/详情/改名/删除（非空 409）、按用户名共享/取消共享、
// 权限边界（T4 只读共享：viewer 可看可复用、不可管理）、新建题目 v1、从问卷存入题库。
process.env.MONGODB_DB = 'survey_system_test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let ctx;
let ownerCookie, viewerCookie, strangerCookie;

before(async () => {
  await h.resetTestDb();
  ctx = await h.startServer();
  ownerCookie = await h.registerAndLogin(ctx.base, 'bankowner');
  viewerCookie = await h.registerAndLogin(ctx.base, 'bankviewer');
  strangerCookie = await h.registerAndLogin(ctx.base, 'bankstranger');
});
after(async () => { await h.stopServer(ctx); });

async function createBank(cookie, name = '常用题库') {
  const r = await h.req(ctx.base, '/api/banks', { method: 'POST', cookie, body: { name, description: '测试题库' } });
  assert.equal(r.status, 201);
  return r.data.id;
}

async function createSurvey(cookie, title = '问卷') {
  const r = await h.req(ctx.base, '/api/surveys', { method: 'POST', cookie, body: { title, allowAnonymous: false, allowRepeat: false } });
  assert.equal(r.status, 201);
  return r.data.id;
}

test('创建题库：空名 400；出现在我的列表，不出现在他人列表', async () => {
  const bad = await h.req(ctx.base, '/api/banks', { method: 'POST', cookie: ownerCookie, body: { name: '  ' } });
  assert.equal(bad.status, 400);

  const id = await createBank(ownerCookie, '我的题库A');
  const mine = await h.req(ctx.base, '/api/banks', { cookie: ownerCookie });
  assert.equal(mine.status, 200);
  assert.ok(mine.data.mine.some((b) => b.id === id && b.role === 'owner'));

  const theirs = await h.req(ctx.base, '/api/banks', { cookie: viewerCookie });
  assert.ok(!theirs.data.mine.some((b) => b.id === id), '他人列表不应包含我的题库');
});

test('权限边界：未共享时他人访问 404（不泄露存在性）', async () => {
  const id = await createBank(ownerCookie);
  for (const [method, path] of [['GET', `/api/banks/${id}`], ['PATCH', `/api/banks/${id}`], ['DELETE', `/api/banks/${id}`], ['GET', `/api/banks/${id}/questions`]]) {
    const r = await h.req(ctx.base, path, { method, cookie: strangerCookie, body: method === 'PATCH' ? { name: 'x' } : undefined });
    assert.equal(r.status, 404, `${method} ${path} 应对无关用户 404`);
  }
});

test('共享（按用户名）：viewer 可见题库与题目列表；未授权 404；共享给自己 400', async () => {
  const id = await createBank(ownerCookie, '共享库');
  const r = await h.req(ctx.base, `/api/banks/${id}/share`, { method: 'POST', cookie: ownerCookie, body: { username: 'bankviewer' } });
  assert.equal(r.status, 200);

  const detail = await h.req(ctx.base, `/api/banks/${id}`, { cookie: viewerCookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.role, 'viewer');

  const list = await h.req(ctx.base, '/api/banks', { cookie: viewerCookie });
  assert.ok(list.data.sharedWithMe.some((b) => b.id === id), '共享给我的题库应出现在 sharedWithMe');

  const self = await h.req(ctx.base, `/api/banks/${id}/share`, { method: 'POST', cookie: ownerCookie, body: { username: 'bankowner' } });
  assert.equal(self.status, 400);

  const missing = await h.req(ctx.base, `/api/banks/${id}/share`, { method: 'POST', cookie: ownerCookie, body: { username: 'no_such_user' } });
  assert.equal(missing.status, 404);
});

test('共享只读（T4）：viewer 不能改名/删库/建题/管理共享，一律 403', async () => {
  const id = await createBank(ownerCookie, '只读共享库');
  await h.req(ctx.base, `/api/banks/${id}/share`, { method: 'POST', cookie: ownerCookie, body: { username: 'bankviewer' } });
  const cases = [
    ['PATCH', `/api/banks/${id}`, { name: '改' }],
    ['DELETE', `/api/banks/${id}`, undefined],
    ['POST', `/api/banks/${id}/questions`, { type: 'single', title: 'x', required: true, options: ['a', 'b'] }],
    ['POST', `/api/banks/${id}/questions/from-survey`, { surveyId: '0'.repeat(24), questionId: '0'.repeat(24) }],
    ['POST', `/api/banks/${id}/share`, { username: 'bankstranger' }],
    ['DELETE', `/api/banks/${id}/share/bankstranger`, undefined],
  ];
  for (const [method, path, body] of cases) {
    const r = await h.req(ctx.base, path, { method, cookie: viewerCookie, body });
    assert.equal(r.status, 403, `${method} ${path} 应 403`);
  }
});

test('取消共享后 viewer 访问 404；sharedWith 仅所有者可见（含用户名）', async () => {
  const id = await createBank(ownerCookie, '待取消库');
  await h.req(ctx.base, `/api/banks/${id}/share`, { method: 'POST', cookie: ownerCookie, body: { username: 'bankviewer' } });
  const ownerDetail = await h.req(ctx.base, `/api/banks/${id}`, { cookie: ownerCookie });
  assert.ok(ownerDetail.data.sharedWith.some((s) => s.username === 'bankviewer' && s.canEdit === false), '所有者应看到共享列表');

  const viewerDetail = await h.req(ctx.base, `/api/banks/${id}`, { cookie: viewerCookie });
  assert.equal(viewerDetail.data.sharedWith, undefined, 'viewer 不应看到共享列表');

  const userId = ownerDetail.data.sharedWith.find((s) => s.username === 'bankviewer').userId;
  const del = await h.req(ctx.base, `/api/banks/${id}/share/${userId}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(del.status, 200);
  const after = await h.req(ctx.base, `/api/banks/${id}`, { cookie: viewerCookie });
  assert.equal(after.status, 404);
});

test('删除题库：含题目 409；清空题目后可删除', async () => {
  const id = await createBank(ownerCookie, '待删除库');
  const q = await h.req(ctx.base, `/api/banks/${id}/questions`, {
    method: 'POST', cookie: ownerCookie,
    body: { type: 'single', title: '性别', required: true, options: ['男', '女'] },
  });
  assert.equal(q.status, 201);
  const blocked = await h.req(ctx.base, `/api/banks/${id}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(blocked.status, 409);

  await h.req(ctx.base, `/api/questions/${q.data.id}`, { method: 'DELETE', cookie: ownerCookie });
  const ok = await h.req(ctx.base, `/api/banks/${id}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(ok.status, 200);
});

test('新建题目 = v1：默认口径、内容正确；题库题目列表可见', async () => {
  const id = await createBank(ownerCookie, '建题库');
  const r = await h.req(ctx.base, `/api/banks/${id}/questions`, {
    method: 'POST', cookie: ownerCookie,
    body: { type: 'single', title: '你的性别', required: true, options: ['男', '女', '其他'], changeNote: '初版', caliberLabel: '默认' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.versionNo, 1);

  const detail = await h.req(ctx.base, `/api/questions/${r.data.id}`, { cookie: ownerCookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.latestVersionNo, 1);
  assert.equal(detail.data.latest.versionNo, 1);
  assert.equal(detail.data.latest.parentVersionNo, null);
  assert.deepEqual(detail.data.latest.content.options.map((o) => o.label), ['男', '女', '其他']);
  assert.ok(detail.data.latest.statsCaliber.caliberKey, 'v1 应有口径标识');
  assert.equal(detail.data.role, 'owner');

  const list = await h.req(ctx.base, `/api/banks/${id}/questions`, { cookie: ownerCookie });
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].title, '你的性别');
});

test('从问卷存入题库：内容剥离 jumps，选项 id 原样保留', async () => {
  const bankId = await createBank(ownerCookie, '存入库');
  const surveyId = await createSurvey(ownerCookie, '来源问卷');
  const add = await h.req(ctx.base, `/api/surveys/${surveyId}/questions`, {
    method: 'POST', cookie: ownerCookie,
    body: { type: 'single', title: '颜色', required: true, options: ['红', '蓝', '绿'] },
  });
  const surveyQid = add.data.id;
  // 配一条跳转（问卷局部结构，存入题库时应被剥离）
  const detail = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie: ownerCookie });
  const greenId = detail.data.questions[0].options.find((o) => o.label === '绿').id;
  const jump = await h.req(ctx.base, `/api/surveys/${surveyId}/questions/${surveyQid}/jumps`, {
    method: 'PUT', cookie: ownerCookie,
    body: { jumps: [{ targetQuestionId: surveyQid, matchMode: 'any', conditions: [{ optionId: greenId }] }] },
  });
  assert.equal(jump.status, 400, '只有一道题时向后跳转应失败'); // 题目后面没有目标题
  // 再加一题作为跳转目标，再存跳转
  await h.req(ctx.base, `/api/surveys/${surveyId}/questions`, { method: 'POST', cookie: ownerCookie, body: { type: 'text', title: '备注', required: false } });
  const jump2 = await h.req(ctx.base, `/api/surveys/${surveyId}/questions/${surveyQid}/jumps`, {
    method: 'PUT', cookie: ownerCookie,
    body: { jumps: [{ targetQuestionId: surveyQid, matchMode: 'any', conditions: [{ optionId: greenId }] }] },
  });
  assert.equal(jump2.status, 400, '跳转目标必须位于该题之后（Q4）');
  const detail2 = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie: ownerCookie });
  const targetId = detail2.data.questions[1].id;
  const jump3 = await h.req(ctx.base, `/api/surveys/${surveyId}/questions/${surveyQid}/jumps`, {
    method: 'PUT', cookie: ownerCookie,
    body: { jumps: [{ targetQuestionId: targetId, matchMode: 'any', conditions: [{ optionId: greenId }] }] },
  });
  assert.equal(jump3.status, 200);

  const saved = await h.req(ctx.base, `/api/banks/${bankId}/questions/from-survey`, {
    method: 'POST', cookie: ownerCookie,
    body: { surveyId, questionId: surveyQid },
  });
  assert.equal(saved.status, 201);
  const q = await h.req(ctx.base, `/api/questions/${saved.data.id}`, { cookie: ownerCookie });
  assert.deepEqual(q.data.latest.content.options.map((o) => o.label), ['红', '蓝', '绿']);
  assert.ok(!q.data.latest.content.jumps, '题库内容不应含 jumps');
  // 选项 id 与问卷中一致（原样保留；HTTP 响应中 id 均为 hex 字符串）
  const surveyOptIds = detail2.data.questions[0].options.map((o) => o.id);
  const bankOptIds = q.data.latest.content.options.map((o) => String(o._id));
  assert.deepEqual(bankOptIds, surveyOptIds, '存入题库应保留选项 id');
});
