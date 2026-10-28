// 单题共享测试（第 20 轮）：题库授权与单题授权独立生效、任一即可只读复用；
// 共享给我的题目列表；所有者可见共享清单（含用户名）；取消共享后访问消失且已加问卷快照不受影响；
// 幂等共享 / 共享给自己 400 / 用户不存在 404 / 写操作 403。
process.env.MONGODB_DB = 'survey_system_test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let ctx;
let ownerCookie, otherCookie, strangerCookie;

before(async () => {
  await h.resetTestDb();
  ctx = await h.startServer();
  ownerCookie = await h.registerAndLogin(ctx.base, 'qshareowner');
  otherCookie = await h.registerAndLogin(ctx.base, 'qshareother');
  strangerCookie = await h.registerAndLogin(ctx.base, 'qsharestgr');
});
after(async () => { await h.stopServer(ctx); });

let bankId, questionId;

async function createSurvey(cookieArg, title) {
  const r = await h.req(ctx.base, '/api/surveys', { method: 'POST', cookie: cookieArg, body: { title, allowAnonymous: false, allowRepeat: false } });
  assert.equal(r.status, 201);
  return r.data.id;
}

test('准备：题库与题目（不共享题库）', async () => {
  const b = await h.req(ctx.base, '/api/banks', { method: 'POST', cookie: ownerCookie, body: { name: '单题共享库' } });
  bankId = b.data.id;
  const q = await h.req(ctx.base, `/api/banks/${bankId}/questions`, {
    method: 'POST', cookie: ownerCookie,
    body: { type: 'single', title: '你的年龄', required: true, options: ['18以下', '18-30', '30以上'] },
  });
  questionId = q.data.id;
});

test('单题共享：按用户名共享；幂等；共享给自己 400；用户不存在 404', async () => {
  const r = await h.req(ctx.base, `/api/questions/${questionId}/share`, { method: 'POST', cookie: ownerCookie, body: { username: 'qshareother' } });
  assert.equal(r.status, 200);
  const again = await h.req(ctx.base, `/api/questions/${questionId}/share`, { method: 'POST', cookie: ownerCookie, body: { username: 'qshareother' } });
  assert.equal(again.status, 200, '重复共享应幂等');
  const self = await h.req(ctx.base, `/api/questions/${questionId}/share`, { method: 'POST', cookie: ownerCookie, body: { username: 'qshareowner' } });
  assert.equal(self.status, 400);
  const missing = await h.req(ctx.base, `/api/questions/${questionId}/share`, { method: 'POST', cookie: ownerCookie, body: { username: 'no_such_user' } });
  assert.equal(missing.status, 404);
  const ownerDetail = await h.req(ctx.base, `/api/questions/${questionId}`, { cookie: ownerCookie });
  const shares = ownerDetail.data.sharedWith.filter((s) => s.username === 'qshareother');
  assert.equal(shares.length, 1, '重复共享不应产生重复记录');
  assert.ok(shares[0].grantedAt, '应记录授权时间');
});

test('被共享者：共享列表可见；题目可读；题库仍不可见；可复用进自己的问卷', async () => {
  const list = await h.req(ctx.base, '/api/questions/shared', { cookie: otherCookie });
  assert.equal(list.status, 200);
  const row = list.data.find((q) => q.id === questionId);
  assert.ok(row, '共享给我的题目列表应包含该题');
  assert.equal(row.title, '你的年龄');
  assert.equal(row.bankName, '单题共享库');

  const detail = await h.req(ctx.base, `/api/questions/${questionId}`, { cookie: otherCookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.role, 'viewer');
  assert.equal(detail.data.sharedWith, undefined, '共享列表仅所有者可见');

  const bank = await h.req(ctx.base, `/api/banks/${bankId}`, { cookie: otherCookie });
  assert.equal(bank.status, 404, '题库本身未共享，应不可见');

  const versions = await h.req(ctx.base, `/api/questions/${questionId}/versions`, { cookie: otherCookie });
  assert.equal(versions.status, 200);

  // 复用：加入自己的问卷
  const surveyId = await createSurvey(otherCookie, '复用卷');
  const add = await h.req(ctx.base, `/api/surveys/${surveyId}/questions/from-bank`, {
    method: 'POST', cookie: otherCookie, body: { bankQuestionId: questionId },
  });
  assert.equal(add.status, 201, '单题授权应可把题目加入自己的问卷');
});

test('被共享者只读：建版本/恢复/归档/删除/管理共享全部 403', async () => {
  for (const [method, path, body] of [
    ['POST', `/api/questions/${questionId}/versions`, { type: 'single', title: 'x', required: true, options: ['a', 'b'] }],
    ['POST', `/api/questions/${questionId}/versions/1/restore`, {}],
    ['POST', `/api/questions/${questionId}/archive`, undefined],
    ['DELETE', `/api/questions/${questionId}`, undefined],
    ['POST', `/api/questions/${questionId}/share`, { username: 'qsharestgr' }],
    ['DELETE', `/api/questions/${questionId}/share/qshareother`, undefined],
  ]) {
    const r = await h.req(ctx.base, path, { method, cookie: otherCookie, body });
    assert.equal(r.status, 403, `${method} ${path} 应对被共享者 403`);
  }
});

test('无关用户：题目与共享列表均不可见', async () => {
  const detail = await h.req(ctx.base, `/api/questions/${questionId}`, { cookie: strangerCookie });
  assert.equal(detail.status, 404);
  const list = await h.req(ctx.base, '/api/questions/shared', { cookie: strangerCookie });
  assert.deepEqual(list.data, []);
});

test('取消共享：访问消失；已加入问卷的快照不受影响', async () => {
  // 被共享者已有使用该题的问卷：先发布并提交一份答卷
  const surveys = await h.req(ctx.base, '/api/surveys', { cookie: otherCookie });
  const surveyId = surveys.data.find((s) => s.title === '复用卷').id;
  await h.req(ctx.base, `/api/surveys/${surveyId}/publish`, { method: 'POST', cookie: otherCookie });
  const detail = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie: otherCookie });
  const qid = detail.data.questions[0].id;
  const opt = detail.data.questions[0].options.find((o) => o.label === '18以下').id;
  const submit = await h.req(ctx.base, `/api/fill/${surveyId}/submit`, { method: 'POST', cookie: otherCookie, body: { answers: [{ questionId: qid, value: opt }] } });
  assert.equal(submit.status, 201);

  const ownerDetail = await h.req(ctx.base, `/api/questions/${questionId}`, { cookie: ownerCookie });
  const otherUid = ownerDetail.data.sharedWith.find((s) => s.username === 'qshareother').userId;
  const del = await h.req(ctx.base, `/api/questions/${questionId}/share/${otherUid}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal(del.status, 200);

  assert.equal((await h.req(ctx.base, `/api/questions/${questionId}`, { cookie: otherCookie })).status, 404, '取消后题目不可访问');
  const list = await h.req(ctx.base, '/api/questions/shared', { cookie: otherCookie });
  assert.ok(!list.data.some((q) => q.id === questionId), '取消后共享列表不再包含该题');

  // 已加入问卷的快照不受影响（仍可统计）
  const stats = await h.req(ctx.base, `/api/stats/${surveyId}`, { cookie: otherCookie });
  assert.equal(stats.status, 200);
  assert.equal(stats.data.questions[0].optionCounts.find((o) => o.label === '18以下').count, 1);
});

test('题库共享与单题共享独立：题库共享后，取消单题共享不影响题库访问', async () => {
  await h.req(ctx.base, `/api/banks/${bankId}/share`, { method: 'POST', cookie: ownerCookie, body: { username: 'qsharestgr' } });
  await h.req(ctx.base, `/api/questions/${questionId}/share`, { method: 'POST', cookie: ownerCookie, body: { username: 'qsharestgr' } });
  assert.equal((await h.req(ctx.base, `/api/questions/${questionId}`, { cookie: strangerCookie })).status, 200, '题库或单题授权均可访问');

  const ownerDetail = await h.req(ctx.base, `/api/questions/${questionId}`, { cookie: ownerCookie });
  const uid = ownerDetail.data.sharedWith.find((s) => s.username === 'qsharestgr').userId;
  await h.req(ctx.base, `/api/questions/${questionId}/share/${uid}`, { method: 'DELETE', cookie: ownerCookie });
  assert.equal((await h.req(ctx.base, `/api/questions/${questionId}`, { cookie: strangerCookie })).status, 200, '题库授权仍在，取消单题共享后仍可访问');
});
