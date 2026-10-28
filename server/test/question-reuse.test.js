// 题目复用测试：从题库添加 = 完整快照 + 来源四字段 + jumps 清空（T3）+ 选项 id 原样保留；
// A 卷 v1、B 卷 v2 互不影响；创建 v3 不影响已添加快照；归档/撤销共享不影响快照（A1）；
// 仅草稿可加（Q5）；共享用户可复用；同题可多次加入同一问卷；版本固定（快照不随题库变化）。
process.env.MONGODB_DB = 'survey_system_test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let ctx;
let cookie, otherCookie, strangerCookie;

before(async () => {
  await h.resetTestDb();
  ctx = await h.startServer();
  cookie = await h.registerAndLogin(ctx.base, 'ruser');
  otherCookie = await h.registerAndLogin(ctx.base, 'rviewer');
  strangerCookie = await h.registerAndLogin(ctx.base, 'rstranger');
});
after(async () => { await h.stopServer(ctx); });

let bankId, questionId;

async function createSurvey(cookieArg, title, allowAnonymous = false) {
  const r = await h.req(ctx.base, '/api/surveys', { method: 'POST', cookie: cookieArg, body: { title, allowAnonymous, allowRepeat: false } });
  assert.equal(r.status, 201);
  return r.data.id;
}

async function fromBank(cookieArg, surveyId, qid, versionNo = undefined) {
  return h.req(ctx.base, `/api/surveys/${surveyId}/questions/from-bank`, {
    method: 'POST', cookie: cookieArg, body: { bankQuestionId: qid, ...(versionNo !== undefined ? { versionNo } : {}) },
  });
}

async function surveyDetail(cookieArg, surveyId) {
  const r = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie: cookieArg });
  assert.equal(r.status, 200);
  return r.data;
}

test('准备：建题库 + 题目 v1', async () => {
  const b = await h.req(ctx.base, '/api/banks', { method: 'POST', cookie, body: { name: '复用题库' } });
  assert.equal(b.status, 201);
  bankId = b.data.id;
  const q = await h.req(ctx.base, `/api/banks/${bankId}/questions`, {
    method: 'POST', cookie,
    body: { type: 'single', title: '颜色', required: true, options: ['红', '蓝', '绿'] },
  });
  assert.equal(q.status, 201);
  questionId = q.data.id;
});

test('从题库添加：完整快照 + 来源四字段 + jumps 清空 + 选项 id 与版本一致', async () => {
  const surveyId = await createSurvey(cookie, 'A卷');
  const r = await fromBank(cookie, surveyId, questionId);
  assert.equal(r.status, 201);

  const version = await h.req(ctx.base, `/api/questions/${questionId}/versions/1`, { cookie });
  const survey = await surveyDetail(cookie, surveyId);
  const q = survey.questions[0];
  assert.equal(q.title, '颜色');
  assert.deepEqual(q.options.map((o) => o.id), version.data.content.options.map((o) => String(o._id)), '选项 id 应原样快照');
  assert.deepEqual(q.jumps, [], 'jumps 应清空（T3）');
  assert.equal(q.sourceQuestionId, questionId, '来源题目 id 应记录');
  assert.equal(q.sourceVersionNo, 1, '来源版本号应记录');
  assert.ok(q.addedAt, '加入时间应记录');
});

test('版本固定：A 卷 v1、B 卷 v2；创建 v3 后 A/B 快照均不变', async () => {
  const surveyA = await createSurvey(cookie, 'A卷-v1');
  await fromBank(cookie, surveyA, questionId); // v1
  const v2 = await h.req(ctx.base, `/api/questions/${questionId}/versions`, {
    method: 'POST', cookie,
    body: { type: 'single', title: '颜色（v2）', required: true, options: ['红', '蓝', '绿', '黄'] },
  });
  assert.equal(v2.status, 201);
  const surveyB = await createSurvey(cookie, 'B卷-v2');
  await fromBank(cookie, surveyB, questionId, 2);

  const aBefore = await surveyDetail(cookie, surveyA);
  const bBefore = await surveyDetail(cookie, surveyB);
  assert.deepEqual(aBefore.questions[0].options.map((o) => o.label), ['红', '蓝', '绿'], 'A 卷应使用 v1 内容');
  assert.deepEqual(bBefore.questions[0].options.map((o) => o.label), ['红', '蓝', '绿', '黄'], 'B 卷应使用 v2 内容');

  const v3 = await h.req(ctx.base, `/api/questions/${questionId}/versions`, {
    method: 'POST', cookie,
    body: { type: 'single', title: '颜色（v3）', required: true, options: ['黑', '白'] },
  });
  assert.equal(v3.status, 201);

  const aAfter = await surveyDetail(cookie, surveyA);
  const bAfter = await surveyDetail(cookie, surveyB);
  assert.deepEqual(JSON.parse(JSON.stringify(aAfter.questions)), JSON.parse(JSON.stringify(aBefore.questions)), '创建 v3 不得改变 A 卷快照');
  assert.deepEqual(JSON.parse(JSON.stringify(bAfter.questions)), JSON.parse(JSON.stringify(bBefore.questions)), '创建 v3 不得改变 B 卷快照');
});

test('A1 隔离：归档题目、撤销共享均不改变已添加快照；填写与统计照旧', async () => {
  const surveyId = await createSurvey(cookie, '隔离卷');
  await fromBank(cookie, surveyId, questionId, 1);
  const before = await surveyDetail(cookie, surveyId);

  // 先共享给 other，再用 other 添加到自己的问卷，然后撤销共享
  await h.req(ctx.base, `/api/banks/${bankId}/share`, { method: 'POST', cookie, body: { username: 'rviewer' } });
  const otherSurvey = await createSurvey(otherCookie, 'viewer卷');
  const viewerAdd = await fromBank(otherCookie, otherSurvey, questionId, 1);
  assert.equal(viewerAdd.status, 201, '共享用户应可复用题目');

  await h.req(ctx.base, `/api/questions/${questionId}/archive`, { method: 'POST', cookie });
  const shareList = await h.req(ctx.base, `/api/banks/${bankId}`, { cookie });
  const viewerUid = shareList.data.sharedWith.find((s) => s.username === 'rviewer').userId;
  await h.req(ctx.base, `/api/banks/${bankId}/share/${viewerUid}`, { method: 'DELETE', cookie });

  const after = await surveyDetail(cookie, surveyId);
  assert.deepEqual(JSON.parse(JSON.stringify(after.questions)), JSON.parse(JSON.stringify(before.questions)), '归档+撤销共享不得改变快照');

  // 填写与统计照旧（发布 → 提交 → 统计）
  const pub = await h.req(ctx.base, `/api/surveys/${surveyId}/publish`, { method: 'POST', cookie });
  assert.equal(pub.status, 200);
  const detail = await surveyDetail(cookie, surveyId);
  const qid = detail.questions[0].id;
  const optRed = detail.questions[0].options.find((o) => o.label === '红').id;
  const submit = await h.req(ctx.base, `/api/fill/${surveyId}/submit`, { method: 'POST', cookie, body: { answers: [{ questionId: qid, value: optRed }] } });
  assert.equal(submit.status, 201);
  const stats = await h.req(ctx.base, `/api/stats/${surveyId}`, { cookie });
  assert.equal(stats.status, 200);
  assert.equal(stats.data.questions[0].optionCounts.find((o) => o.label === '红').count, 1);
});

test('仅草稿可加（Q5）：已发布问卷 from-bank → 409；未授权用户 → 404；无效版本 → 404', async () => {
  const surveyId = await createSurvey(cookie, '已发布卷');
  await h.req(ctx.base, `/api/surveys/${surveyId}/questions`, { method: 'POST', cookie, body: { type: 'text', title: '占位', required: false } });
  await h.req(ctx.base, `/api/surveys/${surveyId}/publish`, { method: 'POST', cookie });
  const locked = await fromBank(cookie, surveyId, questionId);
  assert.equal(locked.status, 409);

  const strangerSurvey = await createSurvey(strangerCookie, '陌生人卷');
  const forbidden = await fromBank(strangerCookie, strangerSurvey, questionId);
  assert.equal(forbidden.status, 404, '无关用户应 404 不泄露存在性');

  const badVersion = await fromBank(cookie, await createSurvey(cookie, '坏版本卷'), questionId, 999);
  assert.equal(badVersion.status, 404);
});

test('同题可多次加入同一问卷：题目 id 不同，来源字段均存在', async () => {
  const surveyId = await createSurvey(cookie, '双份卷');
  await fromBank(cookie, surveyId, questionId, 1);
  await fromBank(cookie, surveyId, questionId, 1);
  const detail = await surveyDetail(cookie, surveyId);
  assert.equal(detail.questions.length, 2);
  assert.notEqual(detail.questions[0].id, detail.questions[1].id, '两次添加应生成不同题目 id');
  const raw = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie });
  assert.ok(raw.data.questions.every((q) => q.sourceQuestionId && q.sourceVersionNo === 1), '来源字段应完整');
});

test('快照后题库删除受限：被使用的题目 409（呼应 T5，防止快照来源悬空）', async () => {
  const del = await h.req(ctx.base, `/api/questions/${questionId}`, { method: 'DELETE', cookie });
  assert.equal(del.status, 409);
});
