// 填写与提交测试：填写页可见性、答案校验、保存、重复限制（Q6）、匿名（Q1）。
process.env.MONGODB_DB = 'survey_system_test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const h = require('./helpers');

let ctx;
let ownerCookie, bobCookie, carolCookie;
let published; // { id, questionId, optionIds }

before(async () => {
  await h.resetTestDb();
  ctx = await h.startServer();
  ownerCookie = await h.registerAndLogin(ctx.base, 'ownerf');
  bobCookie = await h.registerAndLogin(ctx.base, 'bob');
  carolCookie = await h.registerAndLogin(ctx.base, 'carol');
  published = await createPublishedSurvey(ownerCookie, { allowRepeat: false, allowAnonymous: false });
});
after(async () => { await h.stopServer(ctx); });

// 创建并发布一个单选题问卷，返回题目与选项 id
async function createPublishedSurvey(cookie, { allowRepeat = false, allowAnonymous = false } = {}) {
  const created = await h.req(ctx.base, '/api/surveys', {
    method: 'POST', cookie,
    body: { title: '满意度调查', description: '', allowAnonymous, allowRepeat },
  });
  assert.equal(created.status, 201);
  const surveyId = created.data.id;
  const q = await h.req(ctx.base, `/api/surveys/${surveyId}/questions`, {
    method: 'POST', cookie,
    body: { type: 'single', title: '对服务的满意度', required: true, options: ['满意', '不满意'] },
  });
  assert.equal(q.status, 201);
  const detail = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie });
  const question = detail.data.questions[0];
  await h.req(ctx.base, `/api/surveys/${surveyId}/publish`, { method: 'POST', cookie });
  return { id: surveyId, questionId: question.id, optionIds: question.options.map((o) => o.id) };
}

test('填写页：已发布可见，未发布 403，不存在 404', async () => {
  const ok = await h.req(ctx.base, `/api/fill/${published.id}`, { cookie: bobCookie });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.questions[0].options.length, 2);
  assert.equal(ok.data.allowRepeat, false);

  const draft = await h.req(ctx.base, '/api/surveys', {
    method: 'POST', cookie: ownerCookie, body: { title: '草稿问卷', allowAnonymous: false, allowRepeat: false },
  });
  const draftFill = await h.req(ctx.base, `/api/fill/${draft.data.id}`, { cookie: bobCookie });
  assert.equal(draftFill.status, 403);

  const missing = await h.req(ctx.base, `/api/fill/${'0'.repeat(24)}`, { cookie: bobCookie });
  assert.equal(missing.status, 404);
});

test('提交有效答卷并保存（真实数据库验证）', async () => {
  const r = await h.req(ctx.base, `/api/fill/${published.id}/submit`, {
    method: 'POST', cookie: bobCookie,
    body: { answers: [{ questionId: published.questionId, value: published.optionIds[0] }] },
  });
  assert.equal(r.status, 201);
  assert.ok(r.data.id);

  const { getDb } = require('../src/db');
  const doc = await getDb().collection('responses').findOne({ surveyId: new ObjectId(published.id) });
  assert.ok(doc, '答卷应已保存');
  assert.equal(doc.answers.length, 1);
  assert.equal(doc.answers[0].questionId.toHexString(), published.questionId);
  assert.equal(doc.answers[0].value.toHexString(), published.optionIds[0], '值应规范化为选项 ObjectId');
  const bob = await getDb().collection('users').findOne({ username: 'bob' });
  assert.equal(doc.respondentId.toHexString(), bob._id.toHexString(), '应记录填写人身份');
});

test('必答题未答 → 400；无效选项 → 400', async () => {
  const missing = await h.req(ctx.base, `/api/fill/${published.id}/submit`, {
    method: 'POST', cookie: carolCookie, body: { answers: [] },
  });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /必答/);

  const invalid = await h.req(ctx.base, `/api/fill/${published.id}/submit`, {
    method: 'POST', cookie: carolCookie,
    body: { answers: [{ questionId: published.questionId, value: new ObjectId().toHexString() }] },
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /无效/);
});

test('不允许重复填写：第二次提交被拒绝且不覆盖（Q6）', async () => {
  const again = await h.req(ctx.base, `/api/fill/${published.id}/submit`, {
    method: 'POST', cookie: bobCookie,
    body: { answers: [{ questionId: published.questionId, value: published.optionIds[1] }] },
  });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /重复/);

  const { getDb } = require('../src/db');
  const bob = await getDb().collection('users').findOne({ username: 'bob' });
  const count = await getDb().collection('responses').countDocuments({ surveyId: new ObjectId(published.id), respondentId: bob._id });
  assert.equal(count, 1, '第一次答卷应保留且不产生新答卷');
});

test('允许重复填写：两次提交各计一份', async () => {
  const s = await createPublishedSurvey(ownerCookie, { allowRepeat: true });
  for (let i = 0; i < 2; i++) {
    const r = await h.req(ctx.base, `/api/fill/${s.id}/submit`, {
      method: 'POST', cookie: bobCookie,
      body: { answers: [{ questionId: s.questionId, value: s.optionIds[0] }] },
    });
    assert.equal(r.status, 201);
  }
  const { getDb } = require('../src/db');
  const count = await getDb().collection('responses').countDocuments({ surveyId: new ObjectId(s.id) });
  assert.equal(count, 2);
});

test('匿名问卷：答卷不记录 respondentId（Q1）', async () => {
  const s = await createPublishedSurvey(ownerCookie, { allowAnonymous: true });
  const r = await h.req(ctx.base, `/api/fill/${s.id}/submit`, {
    method: 'POST', cookie: bobCookie,
    body: { answers: [{ questionId: s.questionId, value: s.optionIds[0] }] },
  });
  assert.equal(r.status, 201);
  const { getDb } = require('../src/db');
  const doc = await getDb().collection('responses').findOne({ surveyId: new ObjectId(s.id) });
  assert.equal(doc.respondentId, null);
});

test('未登录无法填写/提交', async () => {
  const view = await h.req(ctx.base, `/api/fill/${published.id}`);
  assert.equal(view.status, 401);
  const submit = await h.req(ctx.base, `/api/fill/${published.id}/submit`, { method: 'POST', body: { answers: [] } });
  assert.equal(submit.status, 401);
});

test('并发提交（B1）：不允许重复时恰好一份成功、另一份 409、最终只有一份答卷', async () => {
  const s = await createPublishedSurvey(ownerCookie, { allowRepeat: false });
  const body = { answers: [{ questionId: s.questionId, value: s.optionIds[0] }] };
  const results = await Promise.all([
    h.req(ctx.base, `/api/fill/${s.id}/submit`, { method: 'POST', cookie: bobCookie, body }),
    h.req(ctx.base, `/api/fill/${s.id}/submit`, { method: 'POST', cookie: bobCookie, body }),
  ]);
  const statuses = results.map((r) => r.status).sort((a, b) => a - b);
  assert.deepEqual(statuses, [201, 409], '恰好一个成功、一个明确拒绝');
  const rejected = results.find((r) => r.status === 409);
  assert.ok(rejected && /重复/.test(rejected.data.error), '拒绝方应得到明确的重复提交错误');
  const { getDb } = require('../src/db');
  const count = await getDb().collection('responses').countDocuments({ surveyId: new ObjectId(s.id) });
  assert.equal(count, 1, 'responses 中最终只有一份有效答卷');
});

test('并发提交（B1）：允许重复时两个提交都成功', async () => {
  const s = await createPublishedSurvey(ownerCookie, { allowRepeat: true });
  const body = { answers: [{ questionId: s.questionId, value: s.optionIds[0] }] };
  const results = await Promise.all([
    h.req(ctx.base, `/api/fill/${s.id}/submit`, { method: 'POST', cookie: bobCookie, body }),
    h.req(ctx.base, `/api/fill/${s.id}/submit`, { method: 'POST', cookie: bobCookie, body }),
  ]);
  assert.deepEqual(results.map((r) => r.status), [201, 201], '允许重复时两个都应成功');
  const { getDb } = require('../src/db');
  const count = await getDb().collection('responses').countDocuments({ surveyId: new ObjectId(s.id) });
  assert.equal(count, 2);
});

test('数据库层兜底（B1）：partial unique index 拒绝第二份 repeatAllowed=false 答卷', async () => {
  const { getDb } = require('../src/db');
  const coll = getDb().collection('responses');
  const surveyId = new ObjectId();
  const respondentId = new ObjectId();
  // 注意：insertOne 会回写 _id，不能用展开复用同一个对象
  const doc = () => ({ surveyId, respondentId, repeatAllowed: false, submittedAt: new Date(), answers: [] });
  await coll.insertOne(doc());
  await assert.rejects(
    coll.insertOne(doc()),
    (err) => err && err.code === 11000 && /unique_respondent_per_survey_when_no_repeat/.test(err.message),
    '第二份同 (surveyId, respondentId) 且 repeatAllowed=false 应触发 partial unique index 冲突',
  );
  // repeatAllowed=true 不受该索引约束
  await coll.insertOne({ surveyId, respondentId, repeatAllowed: true, submittedAt: new Date(), answers: [] });
  assert.equal(await coll.countDocuments({ surveyId, respondentId }), 2);
});

test('responses 已实际创建 partial unique index（B1）', async () => {
  const { getDb } = require('../src/db');
  const indexes = await getDb().collection('responses').indexes();
  const found = indexes.find((i) => i.name === 'unique_respondent_per_survey_when_no_repeat');
  assert.ok(found, '应存在 B1 兜底索引');
  assert.equal(found.unique, true);
  assert.deepEqual(found.partialFilterExpression, { respondentId: { $type: 'objectId' }, repeatAllowed: false });
});
