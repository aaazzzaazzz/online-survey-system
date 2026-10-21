// 生命周期测试（范围收敛后）：截止时间、关闭、权限，以及已移除接口（重开/复制）不再可用。
process.env.MONGODB_DB = 'survey_system_test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const h = require('./helpers');

let ctx;
let ownerCookie, otherCookie, bobCookie;

before(async () => {
  await h.resetTestDb();
  ctx = await h.startServer();
  ownerCookie = await h.registerAndLogin(ctx.base, 'ownerlc');
  otherCookie = await h.registerAndLogin(ctx.base, 'otherlc');
  bobCookie = await h.registerAndLogin(ctx.base, 'boblc');
});
after(async () => { await h.stopServer(ctx); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createSurvey(cookie, { allowRepeat = false } = {}) {
  const r = await h.req(ctx.base, '/api/surveys', {
    method: 'POST', cookie,
    body: { title: '生命周期测试问卷', description: '描述', allowAnonymous: false, allowRepeat },
  });
  assert.equal(r.status, 201);
  return r.data.id;
}

async function addQuestion(cookie, surveyId, body) {
  const r = await h.req(ctx.base, `/api/surveys/${surveyId}/questions`, { method: 'POST', cookie, body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}

async function publish(cookie, surveyId) {
  const r = await h.req(ctx.base, `/api/surveys/${surveyId}/publish`, { method: 'POST', cookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

async function patch(cookie, surveyId, body) {
  return h.req(ctx.base, `/api/surveys/${surveyId}`, { method: 'PATCH', cookie, body });
}

async function submit(cookie, surveyId, answers) {
  return h.req(ctx.base, `/api/fill/${surveyId}/submit`, { method: 'POST', cookie, body: { answers } });
}

// 已发布问卷（单选 + 文本）
async function buildPublishedSurvey(cookie, { allowRepeat = false } = {}) {
  const surveyId = await createSurvey(cookie, { allowRepeat });
  await addQuestion(cookie, surveyId, { type: 'single', title: '满意度', required: true, options: ['满意', '不满意'] });
  await addQuestion(cookie, surveyId, { type: 'text', title: '建议', required: true, minLength: 1, maxLength: 20 });
  const detail = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie });
  const qs = detail.data.questions;
  await publish(cookie, surveyId);
  return {
    id: surveyId,
    answers: [
      { questionId: qs[0].id, value: qs[0].options[0].id },
      { questionId: qs[1].id, value: '不错' },
    ],
  };
}

test('截止时间：设置、修改、清除；无效格式与过去时间被拒绝（服务端判断）', async () => {
  const surveyId = await createSurvey(ownerCookie);

  const future1 = new Date(Date.now() + 3600e3).toISOString();
  assert.equal((await patch(ownerCookie, surveyId, { deadline: future1 })).status, 200);
  const future2 = new Date(Date.now() + 7200e3).toISOString();
  assert.equal((await patch(ownerCookie, surveyId, { deadline: future2 })).status, 200);

  const { getDb } = require('../src/db');
  const doc = await getDb().collection('surveys').findOne({ _id: new ObjectId(surveyId) });
  assert.ok(doc.deadline instanceof Date, '应存为 Date');
  assert.equal(doc.deadline.toISOString(), future2, '保存值应与提交值一致（UTC）');

  assert.equal((await patch(ownerCookie, surveyId, { deadline: null })).status, 200);
  const cleared = await getDb().collection('surveys').findOne({ _id: new ObjectId(surveyId) });
  assert.equal(cleared.deadline, null);

  const invalid = await patch(ownerCookie, surveyId, { deadline: 'not-a-date' });
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /格式无效/);

  const past = await patch(ownerCookie, surveyId, { deadline: '2020-01-01T00:00:00.000Z' });
  assert.equal(past.status, 400);
  assert.match(past.data.error, /晚于当前时间/);
});

test('截止时间：截止前可提交，截止后填写页与提交均被拒绝；无截止时间不受影响', async () => {
  const s = await buildPublishedSurvey(ownerCookie, { allowRepeat: true });
  assert.equal((await submit(bobCookie, s.id, s.answers)).status, 201, '无截止时间应正常提交');

  await patch(ownerCookie, s.id, { deadline: new Date(Date.now() + 400).toISOString() });
  assert.equal((await submit(bobCookie, s.id, s.answers)).status, 201, '截止前应成功');

  await sleep(600);
  const r = await submit(bobCookie, s.id, s.answers);
  assert.equal(r.status, 403);
  assert.match(r.data.error, /已截止/);

  const fillGet = await h.req(ctx.base, `/api/fill/${s.id}`, { cookie: bobCookie });
  assert.equal(fillGet.status, 403);
  assert.match(fillGet.data.error, /已截止/);
});

test('截止时间：草稿截止时间已过时发布被拒绝', async () => {
  const surveyId = await createSurvey(ownerCookie);
  await addQuestion(ownerCookie, surveyId, { type: 'text', title: '题', required: false, minLength: 1, maxLength: 5 });
  await patch(ownerCookie, surveyId, { deadline: new Date(Date.now() + 300).toISOString() });
  await sleep(500);
  const r = await h.req(ctx.base, `/api/surveys/${surveyId}/publish`, { method: 'POST', cookie: ownerCookie });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /截止时间已过/);
});

test('主动关闭：填写页与提交被拒绝（服务端），答卷不受影响，且保持关闭', async () => {
  const s = await buildPublishedSurvey(ownerCookie);
  assert.equal((await submit(bobCookie, s.id, s.answers)).status, 201, '关闭前应有一份答卷');

  const close = await h.req(ctx.base, `/api/surveys/${s.id}/close`, { method: 'POST', cookie: ownerCookie });
  assert.equal(close.status, 200);
  const submitClosed = await submit(bobCookie, s.id, s.answers);
  assert.equal(submitClosed.status, 403);
  assert.match(submitClosed.data.error, /已关闭/);
  const fillClosed = await h.req(ctx.base, `/api/fill/${s.id}`, { cookie: bobCookie });
  assert.equal(fillClosed.status, 403);
  assert.match(fillClosed.data.error, /已关闭/);

  const { getDb } = require('../src/db');
  const doc = await getDb().collection('surveys').findOne({ _id: new ObjectId(s.id) });
  assert.equal(doc.status, 'closed');
  assert.ok(doc.closedAt instanceof Date, '应记录关闭时间');
  assert.equal(await getDb().collection('responses').countDocuments({ surveyId: new ObjectId(s.id) }), 1, '关闭不得影响已有答卷');

  // 重复关闭幂等；问卷保持关闭（无重开入口）
  assert.equal((await h.req(ctx.base, `/api/surveys/${s.id}/close`, { method: 'POST', cookie: ownerCookie })).status, 200);
  const stillClosed = await h.req(ctx.base, `/api/fill/${s.id}`, { cookie: bobCookie });
  assert.equal(stillClosed.status, 403);
  assert.match(stillClosed.data.error, /已关闭/);
});

test('未发布问卷：不能被填写者访问，也不能关闭', async () => {
  const surveyId = await createSurvey(ownerCookie);
  await addQuestion(ownerCookie, surveyId, { type: 'text', title: '题', required: false, minLength: 1, maxLength: 5 });
  const fillGet = await h.req(ctx.base, `/api/fill/${surveyId}`, { cookie: bobCookie });
  assert.equal(fillGet.status, 403);
  assert.match(fillGet.data.error, /未发布/);
  const close = await h.req(ctx.base, `/api/surveys/${surveyId}/close`, { method: 'POST', cookie: ownerCookie });
  assert.equal(close.status, 400);
  assert.match(close.data.error, /未发布/);
});

test('权限：非创建者不能修改截止时间或关闭', async () => {
  const s = await buildPublishedSurvey(ownerCookie);
  assert.equal((await patch(otherCookie, s.id, { deadline: null })).status, 404);
  assert.equal((await h.req(ctx.base, `/api/surveys/${s.id}/close`, { method: 'POST', cookie: otherCookie })).status, 404);
});

test('已移除接口：重新开放与复制问卷 API 不再可用（404）', async () => {
  const s = await buildPublishedSurvey(ownerCookie);
  await h.req(ctx.base, `/api/surveys/${s.id}/close`, { method: 'POST', cookie: ownerCookie });

  const reopen = await h.req(ctx.base, `/api/surveys/${s.id}/reopen`, { method: 'POST', cookie: ownerCookie });
  assert.equal(reopen.status, 404, 'reopen 接口应已移除');

  const copy = await h.req(ctx.base, `/api/surveys/${s.id}/copy`, { method: 'POST', cookie: ownerCookie });
  assert.equal(copy.status, 404, 'copy 接口应已移除');
});
