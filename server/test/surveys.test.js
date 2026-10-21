// 问卷管理测试：创建/列表/详情、单选题添加与结构校验、发布与发布后锁定（Q5）、权限隔离。
process.env.MONGODB_DB = 'survey_system_test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const h = require('./helpers');

let ctx;
let ownerCookie, otherCookie;

before(async () => {
  await h.resetTestDb();
  ctx = await h.startServer();
  ownerCookie = await h.registerAndLogin(ctx.base, 'owner1');
  otherCookie = await h.registerAndLogin(ctx.base, 'other1');
});
after(async () => { await h.stopServer(ctx); });

async function createSurvey(cookie, title = '测试问卷') {
  const r = await h.req(ctx.base, '/api/surveys', {
    method: 'POST', cookie,
    body: { title, description: '用于测试的问卷', allowAnonymous: false, allowRepeat: false },
  });
  assert.equal(r.status, 201);
  return r.data.id;
}

async function addSingleQuestion(cookie, surveyId, title = '最喜欢的颜色', options = ['红色', '蓝色']) {
  const r = await h.req(ctx.base, `/api/surveys/${surveyId}/questions`, {
    method: 'POST', cookie,
    body: { type: 'single', title, required: true, options },
  });
  assert.equal(r.status, 201);
  return r.data.id;
}

test('创建问卷：出现在我的列表，不出现在他人列表', async () => {
  const id = await createSurvey(ownerCookie, '我的第一份问卷');

  const mine = await h.req(ctx.base, '/api/surveys', { cookie: ownerCookie });
  assert.equal(mine.status, 200);
  const found = mine.data.find((s) => s.id === id);
  assert.ok(found, '我的列表应包含新问卷');
  assert.equal(found.status, 'draft');
  assert.equal(found.questionCount, 0);

  const theirs = await h.req(ctx.base, '/api/surveys', { cookie: otherCookie });
  assert.ok(!theirs.data.some((s) => s.id === id), '他人列表不应包含我的问卷');
});

test('添加单选题：结构与选项 id', async () => {
  const id = await createSurvey(ownerCookie);
  await addSingleQuestion(ownerCookie, id);

  const detail = await h.req(ctx.base, `/api/surveys/${id}`, { cookie: ownerCookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.questions.length, 1);
  const q = detail.data.questions[0];
  assert.equal(q.type, 'single');
  assert.equal(q.title, '最喜欢的颜色');
  assert.equal(q.required, true);
  assert.equal(q.options.length, 2);
  assert.ok(q.options.every((o) => o.id && o.label));
});

test('题目结构校验：选项不足 2 个 / 选项为空 / 不支持的题型', async () => {
  const id = await createSurvey(ownerCookie);

  const few = await h.req(ctx.base, `/api/surveys/${id}/questions`, {
    method: 'POST', cookie: ownerCookie, body: { type: 'single', title: '题目', required: false, options: ['仅一个'] },
  });
  assert.equal(few.status, 400);

  const blank = await h.req(ctx.base, `/api/surveys/${id}/questions`, {
    method: 'POST', cookie: ownerCookie, body: { type: 'single', title: '题目', required: false, options: ['', '第二个'] },
  });
  assert.equal(blank.status, 400);

  const unsupported = await h.req(ctx.base, `/api/surveys/${id}/questions`, {
    method: 'POST', cookie: ownerCookie, body: { type: 'checkbox', title: '未知题型', required: false, options: ['a', 'b'] },
  });
  assert.equal(unsupported.status, 400);
  assert.match(unsupported.data.error, /不支持的题型/);
});

test('跳转结构校验（Q4，数据层直测）：只允许向后跳转、目标必须存在', () => {
  const { validateSurveyStructure } = require('../src/validation');
  const makeQuestion = (hex) => ({
    _id: new ObjectId(hex),
    type: 'single',
    title: '题目',
    required: true,
    options: [{ _id: new ObjectId(), label: 'A' }, { _id: new ObjectId(), label: 'B' }],
    jumps: [],
  });
  const q1 = makeQuestion('aaaaaaaaaaaaaaaaaaaaaaaa');
  const q2 = makeQuestion('bbbbbbbbbbbbbbbbbbbbbbbb');
  const jump = (target, optionId) => ({ targetQuestionId: target, conditions: [{ optionId }] });

  const ok = validateSurveyStructure({ questions: [{ ...q1, jumps: [jump(q2._id, q1.options[0]._id)] }, q2] });
  assert.equal(ok.length, 0, '向后跳转应通过');

  const backward = validateSurveyStructure({ questions: [q1, { ...q2, jumps: [jump(q1._id, q2.options[0]._id)] }] });
  assert.equal(backward.length, 1);
  assert.match(backward[0].message, /只允许/);

  const missing = validateSurveyStructure({ questions: [{ ...q1, jumps: [jump(new ObjectId(), q1.options[0]._id)] }] });
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /不存在/);
});

test('发布：无题目 → 400；有题目 → 200', async () => {
  const empty = await createSurvey(ownerCookie);
  const fail = await h.req(ctx.base, `/api/surveys/${empty}/publish`, { method: 'POST', cookie: ownerCookie });
  assert.equal(fail.status, 400);

  const id = await createSurvey(ownerCookie);
  await addSingleQuestion(ownerCookie, id);
  const ok = await h.req(ctx.base, `/api/surveys/${id}/publish`, { method: 'POST', cookie: ownerCookie });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, 'published');
});

test('发布后锁定（Q5）：题目不可再添加，标题/说明可改，其他字段不可改', async () => {
  const id = await createSurvey(ownerCookie);
  await addSingleQuestion(ownerCookie, id);
  await h.req(ctx.base, `/api/surveys/${id}/publish`, { method: 'POST', cookie: ownerCookie });

  const add = await h.req(ctx.base, `/api/surveys/${id}/questions`, {
    method: 'POST', cookie: ownerCookie, body: { type: 'single', title: '新题', required: false, options: ['x', 'y'] },
  });
  assert.equal(add.status, 409);
  assert.match(add.data.error, /锁定/);

  const patchTitle = await h.req(ctx.base, `/api/surveys/${id}`, { method: 'PATCH', cookie: ownerCookie, body: { title: '改后的标题' } });
  assert.equal(patchTitle.status, 200);
  const detail = await h.req(ctx.base, `/api/surveys/${id}`, { cookie: ownerCookie });
  assert.equal(detail.data.title, '改后的标题');
  assert.equal(detail.data.status, 'published');

  const patchFlags = await h.req(ctx.base, `/api/surveys/${id}`, { method: 'PATCH', cookie: ownerCookie, body: { allowAnonymous: true } });
  assert.equal(patchFlags.status, 400);
});

test('并发添加题目：5 个并发请求全部成功且不丢失题目（E2E 发现的竞态修复回归）', async () => {
  const id = await createSurvey(ownerCookie);
  const results = await Promise.all([1, 2, 3, 4, 5].map((n) => h.req(ctx.base, `/api/surveys/${id}/questions`, {
    method: 'POST', cookie: ownerCookie,
    body: { type: 'single', title: `并发题 ${n}`, required: false, options: ['a', 'b'] },
  })));
  for (const r of results) assert.equal(r.status, 201, `并发添加应全部成功: ${JSON.stringify(r.data)}`);
  const detail = await h.req(ctx.base, `/api/surveys/${id}`, { cookie: ownerCookie });
  assert.equal(detail.data.questions.length, 5, '5 道并发添加的题目应全部保留');
});

test('权限隔离：他人无法查看或操作我的问卷', async () => {
  const id = await createSurvey(ownerCookie);
  await addSingleQuestion(ownerCookie, id);

  const view = await h.req(ctx.base, `/api/surveys/${id}`, { cookie: otherCookie });
  assert.equal(view.status, 404);

  const addQ = await h.req(ctx.base, `/api/surveys/${id}/questions`, {
    method: 'POST', cookie: otherCookie, body: { type: 'single', title: 'x', required: false, options: ['a', 'b'] },
  });
  assert.equal(addQ.status, 404);

  const publish = await h.req(ctx.base, `/api/surveys/${id}/publish`, { method: 'POST', cookie: otherCookie });
  assert.equal(publish.status, 404);
});
