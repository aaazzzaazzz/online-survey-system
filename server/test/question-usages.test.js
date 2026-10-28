// 使用关系测试：派生查询（无独立集合）、他人问卷标题隐藏（T2）、状态/版本/加入时间正确、
// canViewStats 仅本人问卷为 true、关闭问卷后状态同步、共享用户可查询使用关系。
process.env.MONGODB_DB = 'survey_system_test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let ctx;
let cookie, otherCookie, strangerCookie;

before(async () => {
  await h.resetTestDb();
  ctx = await h.startServer();
  cookie = await h.registerAndLogin(ctx.base, 'uowner');
  otherCookie = await h.registerAndLogin(ctx.base, 'uother');
  strangerCookie = await h.registerAndLogin(ctx.base, 'ustranger');
});
after(async () => { await h.stopServer(ctx); });

let bankId, questionId;

async function createSurvey(cookieArg, title) {
  const r = await h.req(ctx.base, '/api/surveys', { method: 'POST', cookie: cookieArg, body: { title, allowAnonymous: false, allowRepeat: false } });
  assert.equal(r.status, 201);
  return r.data.id;
}

async function fromBank(cookieArg, surveyId, qid, versionNo = undefined) {
  const r = await h.req(ctx.base, `/api/surveys/${surveyId}/questions/from-bank`, {
    method: 'POST', cookie: cookieArg, body: { bankQuestionId: qid, ...(versionNo !== undefined ? { versionNo } : {}) },
  });
  assert.equal(r.status, 201);
}

test('准备：题库 + 题目 v1/v2；owner 与共享用户各建问卷使用', async () => {
  const b = await h.req(ctx.base, '/api/banks', { method: 'POST', cookie, body: { name: '使用关系库' } });
  bankId = b.data.id;
  const q = await h.req(ctx.base, `/api/banks/${bankId}/questions`, {
    method: 'POST', cookie, body: { type: 'single', title: '颜色', required: true, options: ['红', '蓝'] },
  });
  questionId = q.data.id;
  const v2 = await h.req(ctx.base, `/api/questions/${questionId}/versions`, {
    method: 'POST', cookie, body: { type: 'single', title: '颜色v2', required: true, options: ['红', '蓝'] },
  });
  assert.equal(v2.status, 201);

  await h.req(ctx.base, `/api/banks/${bankId}/share`, { method: 'POST', cookie, body: { username: 'uother' } });
  const ownSurvey = await createSurvey(cookie, '我的问卷A');
  await fromBank(cookie, ownSurvey, questionId);          // v2（最新）
  const ownSurvey2 = await createSurvey(cookie, '我的问卷B');
  await fromBank(cookie, ownSurvey2, questionId, 1);      // v1
  const otherSurvey = await createSurvey(otherCookie, '他人的问卷');
  await fromBank(otherCookie, otherSurvey, questionId, 1); // v1
});

test('使用关系：版本/状态/加入时间正确；本人问卷显示标题且 canViewStats，他人问卷标题隐藏（T2）', async () => {
  const r = await h.req(ctx.base, `/api/questions/${questionId}/usages`, { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 3);
  const mineA = r.data.find((u) => u.title === '我的问卷A');
  const mineB = r.data.find((u) => u.title === '我的问卷B');
  const others = r.data.find((u) => u.title === undefined && !u.canViewStats);
  assert.ok(mineA && mineA.canViewStats === true, '本人问卷应显示标题且可看统计');
  assert.equal(mineA.sourceVersionNo, 2);
  assert.equal(mineB.sourceVersionNo, 1);
  assert.ok(mineA.addedAt && mineB.addedAt, '应记录使用关系创建时间');
  assert.equal(mineA.status, 'draft');
  assert.equal(mineA.effectiveStatus, 'draft');
  assert.ok(others, '他人问卷应存在且标题隐藏');
  assert.equal(others.status, 'draft', '他人问卷仍应返回状态');
  assert.equal(others.sourceVersionNo, 1, '他人问卷仍应返回使用版本');
});

test('共享用户也能查询使用关系；无关用户 404', async () => {
  const r = await h.req(ctx.base, `/api/questions/${questionId}/usages`, { cookie: otherCookie });
  assert.equal(r.status, 200);
  assert.ok(r.data.some((u) => u.title === '他人的问卷' && u.canViewStats === true), '共享用户看自己的问卷应显示标题');
  assert.ok(r.data.some((u) => u.title === undefined), '共享用户看他人（题目所有者）的问卷标题应隐藏');

  const denied = await h.req(ctx.base, `/api/questions/${questionId}/usages`, { cookie: strangerCookie });
  assert.equal(denied.status, 404);
});

test('问卷状态变化自动反映在使用关系中（派生查询无冗余）', async () => {
  const surveys = await h.req(ctx.base, '/api/surveys', { cookie });
  const mineA = surveys.data.find((s) => s.title === '我的问卷A');
  await h.req(ctx.base, `/api/surveys/${mineA.id}/publish`, { method: 'POST', cookie });
  await h.req(ctx.base, `/api/surveys/${mineA.id}/close`, { method: 'POST', cookie });
  const r = await h.req(ctx.base, `/api/questions/${questionId}/usages`, { cookie });
  const row = r.data.find((u) => u.surveyId === mineA.id);
  assert.equal(row.status, 'closed');
  assert.equal(row.effectiveStatus, 'closed');
});

test('无使用记录时返回空数组', async () => {
  const b = await h.req(ctx.base, '/api/banks', { method: 'POST', cookie, body: { name: '空库' } });
  const q = await h.req(ctx.base, `/api/banks/${b.data.id}/questions`, {
    method: 'POST', cookie, body: { type: 'text', title: '未使用', required: false },
  });
  const r = await h.req(ctx.base, `/api/questions/${q.data.id}/usages`, { cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, []);
});
