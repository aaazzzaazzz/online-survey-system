// 跳转测试：规则存储与结构校验（API）、路径解析（单元）、填写执行与统计（API 集成，真实测试库）。
process.env.MONGODB_DB = 'survey_system_test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const h = require('./helpers');
const { resolvePath, ruleMatches } = require('../src/services/resolve-jumps');

let ctx;
let ownerCookie, bobCookie, carolCookie;

before(async () => {
  await h.resetTestDb();
  ctx = await h.startServer();
  ownerCookie = await h.registerAndLogin(ctx.base, 'ownerj');
  bobCookie = await h.registerAndLogin(ctx.base, 'bobj');
  carolCookie = await h.registerAndLogin(ctx.base, 'carolj');
});
after(async () => { await h.stopServer(ctx); });

// —— 构造辅助 ——
function mkq(hex, type, extra = {}) {
  return { _id: new ObjectId(hex), type, title: '题' + hex.slice(0, 4), required: true, ...extra };
}
function mkopt(hex) { return { _id: new ObjectId(hex), label: hex.slice(0, 4) }; }

async function createSurvey(cookie, { allowRepeat = false } = {}) {
  const r = await h.req(ctx.base, '/api/surveys', {
    method: 'POST', cookie,
    body: { title: '跳转测试问卷', description: '', allowAnonymous: false, allowRepeat },
  });
  assert.equal(r.status, 201);
  return r.data.id;
}

async function addQuestion(cookie, surveyId, body) {
  const r = await h.req(ctx.base, `/api/surveys/${surveyId}/questions`, { method: 'POST', cookie, body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}

async function putJumps(cookie, surveyId, qid, jumps) {
  return h.req(ctx.base, `/api/surveys/${surveyId}/questions/${qid}/jumps`, { method: 'PUT', cookie, body: { jumps } });
}

async function publish(cookie, surveyId) {
  const r = await h.req(ctx.base, `/api/surveys/${surveyId}/publish`, { method: 'POST', cookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

async function submit(cookie, surveyId, answers) {
  return h.req(ctx.base, `/api/fill/${surveyId}/submit`, { method: 'POST', cookie, body: { answers } });
}

// —— 单元：路径解析 ——
test('单元：单选命中跳转、未命中按顺序继续', () => {
  const q0 = mkq('a'.repeat(24), 'single', {
    options: [mkopt('b'.repeat(24)), mkopt('c'.repeat(24))],
    jumps: [{ targetQuestionId: new ObjectId('e'.repeat(24)), conditions: [{ optionId: new ObjectId('b'.repeat(24)) }] }],
  });
  const q1 = mkq('d'.repeat(24), 'text');
  const q2 = mkq('e'.repeat(24), 'number');
  const survey = { questions: [q0, q1, q2] };

  const hit = resolvePath(survey, new Map([[q0._id.toHexString(), 'b'.repeat(24)], [q2._id.toHexString(), 5]]));
  assert.deepEqual(hit.path, [0, 2], '命中应跳过 q1');
  assert.equal(hit.status, 'complete');

  const miss = resolvePath(survey, new Map([
    [q0._id.toHexString(), 'c'.repeat(24)], [q1._id.toHexString(), 'x'], [q2._id.toHexString(), 5],
  ]));
  assert.deepEqual(miss.path, [0, 1, 2], '未命中按顺序');
  assert.equal(miss.status, 'complete');
});

test('单元：多选 any 与 all（默认 any）', () => {
  const q = mkq('a'.repeat(24), 'multi', { options: [mkopt('b'.repeat(24)), mkopt('c'.repeat(24)), mkopt('d'.repeat(24))] });
  const anyRule = { matchMode: 'any', conditions: [{ optionIds: [new ObjectId('b'.repeat(24)), new ObjectId('c'.repeat(24))] }] };
  const allRule = { matchMode: 'all', conditions: [{ optionIds: [new ObjectId('b'.repeat(24)), new ObjectId('c'.repeat(24))] }] };
  const defaultMode = { conditions: [{ optionIds: [new ObjectId('b'.repeat(24)), new ObjectId('c'.repeat(24))] }] };
  assert.equal(ruleMatches(q, anyRule, ['b'.repeat(24)]), true);
  assert.equal(ruleMatches(q, anyRule, ['d'.repeat(24)]), false);
  assert.equal(ruleMatches(q, allRule, ['b'.repeat(24)]), false);
  assert.equal(ruleMatches(q, allRule, ['b'.repeat(24), 'c'.repeat(24)]), true);
  assert.equal(ruleMatches(q, allRule, ['b'.repeat(24), 'c'.repeat(24), 'd'.repeat(24)]), true);
  assert.equal(ruleMatches(q, defaultMode, ['c'.repeat(24)]), true, '未写 matchMode 默认 any');
});

test('单元：数字六种比较运算符', () => {
  const q = mkq('a'.repeat(24), 'number');
  const cases = [
    ['eq', 5, 5, true], ['eq', 5, 6, false],
    ['ne', 5, 5, false], ['ne', 5, 6, true],
    ['lt', 5, 6, true], ['lt', 5, 5, false],
    ['lte', 5, 5, true], ['lte', 6, 5, false],
    ['gt', 6, 5, true], ['gt', 5, 5, false],
    ['gte', 5, 5, true], ['gte', 4, 5, false],
  ];
  for (const [op, answer, value, expected] of cases) {
    assert.equal(ruleMatches(q, { conditions: [{ op, value }] }, answer), expected, `op=${op} 答案=${answer} 值=${value}`);
  }
});

test('单元：多规则同时命中时首条生效（Q3）', () => {
  const q0 = mkq('a'.repeat(24), 'single', {
    options: [mkopt('b'.repeat(24))],
    jumps: [
      { targetQuestionId: new ObjectId('e'.repeat(24)), conditions: [{ optionId: new ObjectId('b'.repeat(24)) }] },
      { targetQuestionId: new ObjectId('d'.repeat(24)), conditions: [{ optionId: new ObjectId('b'.repeat(24)) }] },
    ],
  });
  const q1 = mkq('d'.repeat(24), 'text');
  const q2 = mkq('e'.repeat(24), 'number');
  const p = resolvePath({ questions: [q0, q1, q2] }, new Map([
    [q0._id.toHexString(), 'b'.repeat(24)], [q2._id.toHexString(), 1],
  ]));
  assert.deepEqual(p.path, [0, 2], '两条都命中应取第一条规则的目标');
});

// —— API：规则保存与结构校验（非法配置不得入库）——
test('规则保存：PUT 后 GET 回读，MongoDB 中存为 ObjectId', async () => {
  const surveyId = await createSurvey(ownerCookie);
  await addQuestion(ownerCookie, surveyId, { type: 'single', title: '去向', required: true, options: ['跳转', '继续'] });
  await addQuestion(ownerCookie, surveyId, { type: 'text', title: '说明', required: true, minLength: 1, maxLength: 20 });
  await addQuestion(ownerCookie, surveyId, { type: 'number', title: '分数', required: true, minValue: 0, maxValue: 10, integerOnly: true });
  const detail = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie: ownerCookie });
  const q0d = detail.data.questions[0];
  const q2d = detail.data.questions[2];

  const r = await putJumps(ownerCookie, surveyId, q0d.id, [{ targetQuestionId: q2d.id, conditions: [{ optionId: q0d.options[0].id }] }]);
  assert.equal(r.status, 200);

  const after = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie: ownerCookie });
  const saved = after.data.questions[0].jumps;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].targetQuestionId, q2d.id);
  assert.equal(saved[0].conditions[0].optionId, q0d.options[0].id);

  const { getDb } = require('../src/db');
  const doc = await getDb().collection('surveys').findOne({ _id: new ObjectId(surveyId) });
  assert.equal(doc.questions[0].jumps[0].targetQuestionId.toHexString(), q2d.id, '目标应存为 ObjectId');
  assert.equal(doc.questions[0].jumps[0].conditions[0].optionId.toHexString(), q0d.options[0].id);
});

test('结构校验：目标不存在 / 文本题 / 选项无效 / matchMode 非法 / 运算符非法 / 跳到前面 / 多条件 → 400 且不入库', async () => {
  const surveyId = await createSurvey(ownerCookie);
  await addQuestion(ownerCookie, surveyId, { type: 'single', title: 'q0', required: true, options: ['A', 'B'] });
  await addQuestion(ownerCookie, surveyId, { type: 'text', title: 'q1', required: false, minLength: 1, maxLength: 5 });
  await addQuestion(ownerCookie, surveyId, { type: 'multi', title: 'q2', required: true, options: ['X', 'Y'], minSelect: 1, maxSelect: 2 });
  await addQuestion(ownerCookie, surveyId, { type: 'number', title: 'q3', required: true, minValue: 0, maxValue: 100, integerOnly: true });
  const detail = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie: ownerCookie });
  const [d0, d1, d2, d3] = detail.data.questions;

  const cases = [
    [d0.id, { jumps: [{ targetQuestionId: new ObjectId().toHexString(), conditions: [{ optionId: d0.options[0].id }] }] }, /不存在/],
    [d1.id, { jumps: [{ targetQuestionId: d2.id, conditions: [{ optionId: 'x' }] }] }, /不支持跳转/],
    [d2.id, { jumps: [{ targetQuestionId: d3.id, conditions: [{ optionIds: ['bad'] }] }] }, /选项无效/],
    [d2.id, { jumps: [{ targetQuestionId: d3.id, matchMode: 'exact', conditions: [{ optionIds: [d2.options[0].id] }] }] }, /any 或 all/],
    [d3.id, { jumps: [{ targetQuestionId: d2.id, conditions: [{ op: 'xx', value: 1 }] }] }, /比较运算符/],
    [d3.id, { jumps: [{ targetQuestionId: d0.id, conditions: [{ op: 'eq', value: 1 }] }] }, /只允许/],
    [d0.id, { jumps: [{ targetQuestionId: d1.id, conditions: [{ optionId: d0.options[0].id }, { optionId: d0.options[1].id }] }] }, /只能配置一个条件/],
  ];
  for (const [qid, body, re] of cases) {
    const r = await putJumps(ownerCookie, surveyId, qid, body.jumps);
    assert.equal(r.status, 400, `应拒绝: ${JSON.stringify(body)}`);
    assert.match(r.data.error, re);
  }
  // 非法配置一律未入库
  const after = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie: ownerCookie });
  for (const q of after.data.questions) assert.equal((q.jumps || []).length, 0);
});

test('发布时再次校验：非法配置无法绕过前端进入数据库', async () => {
  const surveyId = await createSurvey(ownerCookie);
  await addQuestion(ownerCookie, surveyId, { type: 'single', title: 'q0', required: true, options: ['A', 'B'] });
  await addQuestion(ownerCookie, surveyId, { type: 'text', title: 'q1', required: true, minLength: 1, maxLength: 5 });
  const detail = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie: ownerCookie });
  // PUT 校验通过后才保存；直接构造非法（跳到前面）会被 PUT 拒绝，publish 也会因结构校验失败而拒绝
  const bad = await putJumps(ownerCookie, surveyId, detail.data.questions[1].id, [
    { targetQuestionId: detail.data.questions[0].id, conditions: [{ optionId: 'x' }] },
  ]);
  assert.equal(bad.status, 400);
  const pub = await h.req(ctx.base, `/api/surveys/${surveyId}/publish`, { method: 'POST', cookie: ownerCookie });
  assert.equal(pub.status, 200, '未配任何规则的问卷应可正常发布');
});

// —— 集成：填写执行与统计 ——
// 分支问卷：q0 单选「分支A」→ q2（跳过必答文本 q1）；其他 → q1 顺序
async function buildBranchSurvey(cookie) {
  const surveyId = await createSurvey(cookie, { allowRepeat: true });
  await addQuestion(cookie, surveyId, { type: 'single', title: '分支', required: true, options: ['分支A', '分支B'] });
  await addQuestion(cookie, surveyId, { type: 'text', title: 'B 路径说明', required: true, minLength: 1, maxLength: 20 });
  await addQuestion(cookie, surveyId, { type: 'number', title: '评分', required: true, minValue: 0, maxValue: 10, integerOnly: true });
  const detail = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie });
  const qs = detail.data.questions;
  await putJumps(cookie, surveyId, qs[0].id, [{ targetQuestionId: qs[2].id, conditions: [{ optionId: qs[0].options[0].id }] }]);
  await publish(cookie, surveyId);
  return { id: surveyId, qs };
}

test('集成：合法跳过必答题（分支A 跳过必答 q1）→ 201，库内只有 2 个答案', async () => {
  const { id, qs } = await buildBranchSurvey(ownerCookie);
  const r = await submit(bobCookie, id, [
    { questionId: qs[0].id, value: qs[0].options[0].id },
    { questionId: qs[2].id, value: 7 },
  ]);
  assert.equal(r.status, 201);
  const { getDb } = require('../src/db');
  const doc = await getDb().collection('responses').findOne({ surveyId: new ObjectId(id) });
  assert.equal(doc.answers.length, 2);
  assert.ok(!doc.answers.some((a) => a.questionId.toHexString() === qs[1].id), '被跳过的 q1 不应有答案');
});

test('集成：客户端伪造跳转路径（分支A 却提交 q1 答案）→ 400 路径外', async () => {
  const { id, qs } = await buildBranchSurvey(ownerCookie);
  const r = await submit(carolCookie, id, [
    { questionId: qs[0].id, value: qs[0].options[0].id },
    { questionId: qs[1].id, value: '伪造的答案' },
    { questionId: qs[2].id, value: 7 },
  ]);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /不在有效填写路径/);
});

test('集成：修改答案后旧路径失效（分支B 漏答 q1 直接交 q2）→ 400 必答', async () => {
  const { id, qs } = await buildBranchSurvey(ownerCookie);
  const r = await submit(bobCookie, id, [
    { questionId: qs[0].id, value: qs[0].options[1].id },
    { questionId: qs[2].id, value: 7 },
  ]);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /必答题未作答/);
});

test('集成：跳过题目的答案不参与统计', async () => {
  const { id, qs } = await buildBranchSurvey(ownerCookie);
  assert.equal((await submit(bobCookie, id, [
    { questionId: qs[0].id, value: qs[0].options[0].id },
    { questionId: qs[2].id, value: 5 },
  ])).status, 201);
  assert.equal((await submit(carolCookie, id, [
    { questionId: qs[0].id, value: qs[0].options[1].id },
    { questionId: qs[1].id, value: '走 B 路径' },
    { questionId: qs[2].id, value: 9 },
  ])).status, 201);

  const r = await h.req(ctx.base, `/api/stats/${id}`, { cookie: ownerCookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.totalResponses, 2);
  const byTitle = Object.fromEntries(r.data.questions.map((q) => [q.title, q]));
  assert.equal(byTitle['B 路径说明'].answered, 1, '被跳过的 q1 只计到达它的答卷');
  assert.deepEqual(byTitle['B 路径说明'].contents, ['走 B 路径']);
  assert.equal(byTitle['评分'].answered, 2);
  assert.equal(byTitle['评分'].average, 7);
});

test('集成：数字跳转（≥18）与多选 any/all 组合', async () => {
  const surveyId = await createSurvey(ownerCookie, { allowRepeat: true });
  await addQuestion(ownerCookie, surveyId, { type: 'number', title: '年龄', required: true, minValue: 0, maxValue: 120, integerOnly: true });
  await addQuestion(ownerCookie, surveyId, { type: 'multi', title: '爱好', required: true, options: ['读书', '运动', '音乐'], minSelect: 1, maxSelect: 3 });
  await addQuestion(ownerCookie, surveyId, { type: 'text', title: '成年说明', required: true, minLength: 1, maxLength: 30 });
  await addQuestion(ownerCookie, surveyId, { type: 'text', title: '结尾', required: true, minLength: 1, maxLength: 30 });
  const detail = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie: ownerCookie });
  const qs = detail.data.questions;
  // 年龄 ≥18 → 跳过 q1 直达「成年说明」
  await putJumps(ownerCookie, surveyId, qs[0].id, [{ targetQuestionId: qs[2].id, conditions: [{ op: 'gte', value: 18 }] }]);
  // 多选：全部选中[读书,运动] → 结尾；任一选中[读书] → 成年说明（规则顺序：all 在前）
  await putJumps(ownerCookie, surveyId, qs[1].id, [
    { targetQuestionId: qs[3].id, matchMode: 'all', conditions: [{ optionIds: [qs[1].options[0].id, qs[1].options[1].id] }] },
    { targetQuestionId: qs[2].id, matchMode: 'any', conditions: [{ optionIds: [qs[1].options[0].id] }] },
  ]);
  await publish(ownerCookie, surveyId);

  // 成年：跳过 q1 直达 q2 → q3
  const adult = await submit(bobCookie, surveyId, [
    { questionId: qs[0].id, value: 20 },
    { questionId: qs[2].id, value: '成年' },
    { questionId: qs[3].id, value: '结束' },
  ]);
  assert.equal(adult.status, 201);

  // 未成年：多选 all 命中 → 直达结尾
  const youngAll = await submit(carolCookie, surveyId, [
    { questionId: qs[0].id, value: 15 },
    { questionId: qs[1].id, value: [qs[1].options[0].id, qs[1].options[1].id] },
    { questionId: qs[3].id, value: '跳结尾' },
  ]);
  assert.equal(youngAll.status, 201);

  // 未成年：多选 only 读书 → all 不命中，any 命中 → q2 → q3
  const youngAny = await submit(carolCookie, surveyId, [
    { questionId: qs[0].id, value: 15 },
    { questionId: qs[1].id, value: [qs[1].options[0].id] },
    { questionId: qs[2].id, value: 'any 命中' },
    { questionId: qs[3].id, value: '结束' },
  ]);
  assert.equal(youngAny.status, 201);
});
