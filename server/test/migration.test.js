// 历史数据兼容与回滚测试：
// 1) 旧结构问卷（题目无来源字段）在新功能上线后填写/提交/统计行为不变；
// 2) 回滚路径：删除三个新集合后现有功能不受影响（来源字段是惰性数据，旧代码忽略）；
// 3) 从题库添加的问卷在回滚后仍可正常填写（快照自包含，不依赖题库）。
process.env.MONGODB_DB = 'survey_system_test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const h = require('./helpers');

let ctx;
let cookie;

before(async () => {
  await h.resetTestDb();
  ctx = await h.startServer();
  cookie = await h.registerAndLogin(ctx.base, 'muser');
});
after(async () => {
  await h.stopServer(ctx);
  if (directClient) await directClient.close();
});

// 直连客户端复用并随测试结束关闭（否则 node:test 进程不退出）
let directClient = null;
async function directDb() {
  if (!directClient) {
    directClient = new MongoClient('mongodb://127.0.0.1:27017');
    await directClient.connect();
  }
  return directClient.db('survey_system_test');
}

async function createSurvey(title, allowAnonymous = false) {
  const r = await h.req(ctx.base, '/api/surveys', { method: 'POST', cookie, body: { title, allowAnonymous, allowRepeat: false } });
  assert.equal(r.status, 201);
  return r.data.id;
}

test('旧结构问卷（无来源字段）：填写/提交/统计行为与升级前一致', async () => {
  const surveyId = await createSurvey('旧结构问卷');
  const add = await h.req(ctx.base, `/api/surveys/${surveyId}/questions`, {
    method: 'POST', cookie,
    body: { type: 'single', title: '颜色', required: true, options: ['红', '蓝'] },
  });
  assert.equal(add.status, 201);
  const detail = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie });
  assert.equal(detail.data.questions[0].sourceQuestionId, null, '旧题目应无来源字段（公开结构为 null）');

  await h.req(ctx.base, `/api/surveys/${surveyId}/publish`, { method: 'POST', cookie });
  const qid = detail.data.questions[0].id;
  const red = detail.data.questions[0].options.find((o) => o.label === '红').id;
  const submit = await h.req(ctx.base, `/api/fill/${surveyId}/submit`, { method: 'POST', cookie, body: { answers: [{ questionId: qid, value: red }] } });
  assert.equal(submit.status, 201);

  const stats = await h.req(ctx.base, `/api/stats/${surveyId}`, { cookie });
  assert.equal(stats.status, 200);
  assert.equal(stats.data.questions[0].optionCounts.find((o) => o.label === '红').count, 1);
});

test('回滚路径：删除三个新集合后，现有功能与快照问卷均不受影响', async () => {
  // 先建一套题库数据 + 从题库添加的问卷与答卷
  const bank = await h.req(ctx.base, '/api/banks', { method: 'POST', cookie, body: { name: '回滚前题库' } });
  const q = await h.req(ctx.base, `/api/banks/${bank.data.id}/questions`, {
    method: 'POST', cookie, body: { type: 'single', title: '快照题', required: true, options: ['是', '否'] },
  });
  const surveyId = await createSurvey('快照问卷');
  await h.req(ctx.base, `/api/surveys/${surveyId}/questions/from-bank`, { method: 'POST', cookie, body: { bankQuestionId: q.data.id } });
  await h.req(ctx.base, `/api/surveys/${surveyId}/publish`, { method: 'POST', cookie });
  const detail = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie });
  const qid = detail.data.questions[0].id;
  const yes = detail.data.questions[0].options.find((o) => o.label === '是').id;
  await h.req(ctx.base, `/api/fill/${surveyId}/submit`, { method: 'POST', cookie, body: { answers: [{ questionId: qid, value: yes }] } });

  // 模拟回滚：删除三个新集合
  const db = await directDb();
  await db.collection('question_banks').drop();
  await db.collection('questions').drop();
  await db.collection('question_versions').drop();

  // 现有功能不受影响
  const surveys = await h.req(ctx.base, '/api/surveys', { cookie });
  assert.equal(surveys.status, 200);
  assert.ok(surveys.data.some((s) => s.title === '快照问卷'));

  const stats = await h.req(ctx.base, `/api/stats/${surveyId}`, { cookie });
  assert.equal(stats.status, 200, '删除新集合后统计应照常');
  assert.equal(stats.data.questions[0].optionCounts.find((o) => o.label === '是').count, 1);

  const fill = await h.req(ctx.base, `/api/fill/${surveyId}`, { cookie });
  assert.equal(fill.status, 200, '快照自包含，回滚后填写页应照常');
  assert.equal(fill.data.questions[0].title, '快照题');

  // 答卷解释不受影响（历史答卷依据问卷内嵌快照）
  const dbAfter = await directDb();
  const responses = await dbAfter.collection('responses').countDocuments({ surveyId: { $exists: true } });
  assert.ok(responses >= 2, '历史答卷未被删除或修改');
});

test('回滚后题库接口安全降级：列表为空，题目接口 404', async () => {
  const banks = await h.req(ctx.base, '/api/banks', { cookie });
  assert.equal(banks.status, 200);
  assert.deepEqual(banks.data.mine, []);
  const question = await h.req(ctx.base, '/api/questions/aaaaaaaaaaaaaaaaaaaaaaaa', { cookie });
  assert.equal(question.status, 404);
});
