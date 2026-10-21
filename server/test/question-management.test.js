// 题目管理测试（范围收敛后）：保留"创建问卷时添加多个题目"能力与发布后锁定；
// 验证已移除的编辑/删除/排序接口与入口不再可用；题目/选项稳定 ID 保留。
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
  ownerCookie = await h.registerAndLogin(ctx.base, 'ownerqm');
  otherCookie = await h.registerAndLogin(ctx.base, 'otherqm');
});
after(async () => { await h.stopServer(ctx); });

async function createSurvey(cookie, { allowRepeat = false } = {}) {
  const r = await h.req(ctx.base, '/api/surveys', {
    method: 'POST', cookie,
    body: { title: '题目管理测试', description: '', allowAnonymous: false, allowRepeat },
  });
  assert.equal(r.status, 201);
  return r.data.id;
}

async function addQuestion(cookie, surveyId, body) {
  const r = await h.req(ctx.base, `/api/surveys/${surveyId}/questions`, { method: 'POST', cookie, body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}

async function getDetail(cookie, surveyId) {
  return h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie });
}

async function publish(cookie, surveyId) {
  const r = await h.req(ctx.base, `/api/surveys/${surveyId}/publish`, { method: 'POST', cookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

test('创建问卷时添加多个题目：四题型与配置正常，题目/选项生成稳定 ID', async () => {
  const surveyId = await createSurvey(ownerCookie);
  await addQuestion(ownerCookie, surveyId, { type: 'single', title: '渠道', required: true, options: ['线上', '线下'] });
  await addQuestion(ownerCookie, surveyId, { type: 'multi', title: '关注', required: true, options: ['价格', '质量'], minSelect: 1, maxSelect: 2 });
  await addQuestion(ownerCookie, surveyId, { type: 'text', title: '建议', required: false, minLength: 2, maxLength: 10 });
  await addQuestion(ownerCookie, surveyId, { type: 'number', title: '分数', required: true, minValue: 0, maxValue: 10, integerOnly: true });

  const detail = await getDetail(ownerCookie, surveyId);
  assert.equal(detail.status, 200);
  const qs = detail.data.questions;
  assert.equal(qs.length, 4);
  assert.deepEqual(qs.map((q) => q.type), ['single', 'multi', 'text', 'number']);
  assert.equal(qs[1].minSelect, 1);
  assert.equal(qs[1].maxSelect, 2);
  assert.equal(qs[2].minLength, 2);
  assert.equal(qs[3].maxValue, 10);
  assert.equal(qs[3].integerOnly, true);
  // 稳定 ID：题目与选项均有独立 ObjectId
  const qIds = new Set(qs.map((q) => q.id));
  assert.equal(qIds.size, 4, '题目 id 应互不相同');
  for (const q of qs.slice(0, 2)) {
    assert.ok(q.options.every((o) => o.id && o.id.length === 24), '选项应有稳定 id');
  }
  // 跳转规则仍可配置（核心需求 9）
  const jumps = await h.req(ctx.base, `/api/surveys/${surveyId}/questions/${qs[0].id}/jumps`, {
    method: 'PUT', cookie: ownerCookie,
    body: { jumps: [{ targetQuestionId: qs[2].id, conditions: [{ optionId: qs[0].options[0].id }] }] },
  });
  assert.equal(jumps.status, 200);
});

test('发布后题目结构锁定：不能继续添加题目（409）', async () => {
  const surveyId = await createSurvey(ownerCookie);
  await addQuestion(ownerCookie, surveyId, { type: 'text', title: '题', required: false, minLength: 1, maxLength: 5 });
  await publish(ownerCookie, surveyId);
  const r = await h.req(ctx.base, `/api/surveys/${surveyId}/questions`, {
    method: 'POST', cookie: ownerCookie,
    body: { type: 'text', title: '新题', required: false, minLength: 1, maxLength: 5 },
  });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /锁定/);
});

test('已移除接口：题目编辑、删除、排序 API 不再可用（404）', async () => {
  const surveyId = await createSurvey(ownerCookie);
  await addQuestion(ownerCookie, surveyId, { type: 'single', title: '题', required: true, options: ['A', 'B'] });
  const qid = (await getDetail(ownerCookie, surveyId)).data.questions[0].id;

  const edit = await h.req(ctx.base, `/api/surveys/${surveyId}/questions/${qid}`, {
    method: 'PUT', cookie: ownerCookie,
    body: { type: 'text', title: '改', required: false, minLength: 1, maxLength: 5 },
  });
  assert.equal(edit.status, 404, '编辑接口应已移除');

  const del = await h.req(ctx.base, `/api/surveys/${surveyId}/questions/${qid}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(del.status, 404, '删除接口应已移除');

  const order = await h.req(ctx.base, `/api/surveys/${surveyId}/questions/order`, {
    method: 'PUT', cookie: ownerCookie, body: { questionIds: [qid] },
  });
  assert.equal(order.status, 404, '排序接口应已移除');
});

test('权限：非创建者不能添加题目', async () => {
  const surveyId = await createSurvey(ownerCookie);
  const r = await h.req(ctx.base, `/api/surveys/${surveyId}/questions`, {
    method: 'POST', cookie: otherCookie,
    body: { type: 'text', title: '题', required: false, minLength: 1, maxLength: 5 },
  });
  assert.equal(r.status, 404);
});
