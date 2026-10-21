// 题型测试：多选 / 文本 / 数字的创建、结构校验、答案校验、统计与落库（真实测试库）。
process.env.MONGODB_DB = 'survey_system_test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const h = require('./helpers');

let ctx;
let ownerCookie, rCookie;

before(async () => {
  await h.resetTestDb();
  ctx = await h.startServer();
  ownerCookie = await h.registerAndLogin(ctx.base, 'ownerq');
  rCookie = await h.registerAndLogin(ctx.base, 'respq');
});
after(async () => { await h.stopServer(ctx); });

// 创建含指定题目的问卷并发布（allowRepeat=true 便于同一答者多次提交测试）
async function createPublishedSurvey(questions) {
  const created = await h.req(ctx.base, '/api/surveys', {
    method: 'POST', cookie: ownerCookie,
    body: { title: '题型测试问卷', description: '', allowAnonymous: false, allowRepeat: true },
  });
  assert.equal(created.status, 201);
  const surveyId = created.data.id;
  for (const q of questions) {
    const r = await h.req(ctx.base, `/api/surveys/${surveyId}/questions`, { method: 'POST', cookie: ownerCookie, body: q });
    assert.equal(r.status, 201, `添加题目失败: ${JSON.stringify(q)} → ${JSON.stringify(r.data)}`);
  }
  await h.req(ctx.base, `/api/surveys/${surveyId}/publish`, { method: 'POST', cookie: ownerCookie });
  const detail = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie: ownerCookie });
  return { id: surveyId, questions: detail.data.questions };
}

async function submit(surveyId, answers) {
  return h.req(ctx.base, `/api/fill/${surveyId}/submit`, { method: 'POST', cookie: rCookie, body: { answers } });
}

const MULTI = { type: 'multi', title: '喜欢的运动', required: true, options: ['跑步', '游泳', '骑行'], minSelect: 1, maxSelect: 2 };
const TEXT = { type: 'text', title: '想说的话', required: false, minLength: 3, maxLength: 10 };
const NUMBER = { type: 'number', title: '年龄', required: false, minValue: 0, maxValue: 120, integerOnly: false };

test('创建：多选/文本/数字题保存了各自配置字段', async () => {
  const s = await createPublishedSurvey([MULTI, TEXT, NUMBER]);
  const [multi, text, num] = s.questions;
  assert.equal(multi.minSelect, 1);
  assert.equal(multi.maxSelect, 2);
  assert.equal(text.minLength, 3);
  assert.equal(text.maxLength, 10);
  assert.equal(num.minValue, 0);
  assert.equal(num.maxValue, 120);
  assert.equal(num.integerOnly, false);
});

test('结构校验：多选最少>最多 / 最少超选项数 / 文本最少>最多 / 数字最小>最大 → 400', async () => {
  const created = await h.req(ctx.base, '/api/surveys', {
    method: 'POST', cookie: ownerCookie,
    body: { title: '结构校验', allowAnonymous: false, allowRepeat: false },
  });
  const surveyId = created.data.id;
  const cases = [
    { ...MULTI, minSelect: 3, maxSelect: 1 },
    { ...MULTI, minSelect: 4 },
    { ...TEXT, minLength: 5, maxLength: 2 },
    { ...NUMBER, minValue: 100, maxValue: 1 },
  ];
  for (const q of cases) {
    const r = await h.req(ctx.base, `/api/surveys/${surveyId}/questions`, { method: 'POST', cookie: ownerCookie, body: q });
    assert.equal(r.status, 400, `应拒绝非法配置: ${JSON.stringify(q)}`);
    assert.ok(r.data.error, '应给出错误信息');
  }
});

test('多选：合法答案（最少 1 最多 2，选 2 项）→ 201，库内值为选项 id 数组', async () => {
  const s = await createPublishedSurvey([MULTI]);
  const q = s.questions[0];
  const r = await submit(s.id, [{ questionId: q.id, value: [q.options[0].id, q.options[1].id] }]);
  assert.equal(r.status, 201);
  const { getDb } = require('../src/db');
  const doc = await getDb().collection('responses').findOne({ surveyId: new ObjectId(s.id) });
  assert.ok(Array.isArray(doc.answers[0].value), '多选答案应为数组');
  assert.deepEqual(doc.answers[0].value.map((v) => v.toHexString()).sort(), [q.options[0].id, q.options[1].id].sort());
});

test('多选：少选（最少 2 选 1）→ 400 且错误信息指明题目', async () => {
  const s = await createPublishedSurvey([{ ...MULTI, minSelect: 2, maxSelect: 2 }]);
  const q = s.questions[0];
  const r = await submit(s.id, [{ questionId: q.id, value: [q.options[0].id] }]);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /喜欢的运动/);
  assert.match(r.data.error, /至少需选择 2 项/);
});

test('多选：超出最大数量（最多 2 选 3）→ 400', async () => {
  const s = await createPublishedSurvey([MULTI]);
  const q = s.questions[0];
  const r = await submit(s.id, [{ questionId: q.id, value: [q.options[0].id, q.options[1].id, q.options[2].id] }]);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /最多可选 2 项/);
});

test('多选：指定数量（min==max==2）恰好选 2 → 201', async () => {
  const s = await createPublishedSurvey([{ ...MULTI, minSelect: 2, maxSelect: 2 }]);
  const q = s.questions[0];
  const r = await submit(s.id, [{ questionId: q.id, value: [q.options[0].id, q.options[1].id] }]);
  assert.equal(r.status, 201);
});

test('文本：合法答案（3–10 字）→ 201，库内值为字符串', async () => {
  const s = await createPublishedSurvey([TEXT]);
  const q = s.questions[0];
  const r = await submit(s.id, [{ questionId: q.id, value: '你好世界' }]);
  assert.equal(r.status, 201);
  const { getDb } = require('../src/db');
  const doc = await getDb().collection('responses').findOne({ surveyId: new ObjectId(s.id) });
  assert.equal(doc.answers[0].value, '你好世界');
});

test('文本：过短（2 字 < 3）→ 400', async () => {
  const s = await createPublishedSurvey([TEXT]);
  const q = s.questions[0];
  const r = await submit(s.id, [{ questionId: q.id, value: '你好' }]);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /至少 3 字/);
});

test('文本：过长（11 字 > 10）→ 400', async () => {
  const s = await createPublishedSurvey([TEXT]);
  const q = s.questions[0];
  const r = await submit(s.id, [{ questionId: q.id, value: '一二三四五六七八九十一' }]);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /最多 10 字/);
});

test('数字：合法答案（0–120 内）→ 201，库内值为 number 类型', async () => {
  const s = await createPublishedSurvey([NUMBER]);
  const q = s.questions[0];
  const r = await submit(s.id, [{ questionId: q.id, value: 42 }]);
  assert.equal(r.status, 201);
  const { getDb } = require('../src/db');
  const doc = await getDb().collection('responses').findOne({ surveyId: new ObjectId(s.id) });
  assert.equal(typeof doc.answers[0].value, 'number');
  assert.equal(doc.answers[0].value, 42);
});

test('数字：低于最小值 → 400', async () => {
  const s = await createPublishedSurvey([NUMBER]);
  const q = s.questions[0];
  const r = await submit(s.id, [{ questionId: q.id, value: -5 }]);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /不能小于 0/);
});

test('数字：超过最大值 → 400', async () => {
  const s = await createPublishedSurvey([NUMBER]);
  const q = s.questions[0];
  const r = await submit(s.id, [{ questionId: q.id, value: 200 }]);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /不能大于 120/);
});

test('数字：整数限制（3.5 拒绝、3 通过）', async () => {
  const s = await createPublishedSurvey([{ ...NUMBER, minValue: null, maxValue: null, integerOnly: true }]);
  const q = s.questions[0];
  const bad = await submit(s.id, [{ questionId: q.id, value: 3.5 }]);
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /必须填写整数/);
  const ok = await submit(s.id, [{ questionId: q.id, value: 3 }]);
  assert.equal(ok.status, 201);
});

test('必答题为空 → 400 且指明题目', async () => {
  const s = await createPublishedSurvey([MULTI]);
  const r = await submit(s.id, []);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /喜欢的运动/);
  assert.match(r.data.error, /必答/);
});

test('可选题为空 → 201，答卷不含该题答案', async () => {
  const s = await createPublishedSurvey([TEXT, NUMBER]);
  const r = await submit(s.id, []);
  assert.equal(r.status, 201);
  const { getDb } = require('../src/db');
  const doc = await getDb().collection('responses').findOne({ surveyId: new ObjectId(s.id) });
  assert.deepEqual(doc.answers, []);
});

test('非法选项：多选含不存在的选项 id → 400', async () => {
  const s = await createPublishedSurvey([MULTI]);
  const q = s.questions[0];
  const r = await submit(s.id, [{ questionId: q.id, value: [q.options[0].id, new ObjectId().toHexString()] }]);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /无效选项/);
});

test('非法答案类型：数字给字符串 / 多选给字符串 / 文本给数字 → 400', async () => {
  // 每题单独建卷（跳转路径语义下，未答前面的必答题会被判为路径外，无法直达后面的题）
  const sNum = await createPublishedSurvey([NUMBER]);
  const numStr = await submit(sNum.id, [{ questionId: sNum.questions[0].id, value: '5' }]);
  assert.equal(numStr.status, 400);
  assert.match(numStr.data.error, /必须是数字/);

  const sMulti = await createPublishedSurvey([MULTI]);
  const multiStr = await submit(sMulti.id, [{ questionId: sMulti.questions[0].id, value: 'abc' }]);
  assert.equal(multiStr.status, 400);
  assert.match(multiStr.data.error, /必须是选项 id 数组/);

  const sText = await createPublishedSurvey([TEXT]);
  const textNum = await submit(sText.id, [{ questionId: sText.questions[0].id, value: 123 }]);
  assert.equal(textNum.status, 400);
  assert.match(textNum.data.error, /必须是字符串/);
});

test('空答案绕过被拦截（验收发现）：必答文本空串/纯空格、必答多选空数组 → 400；可选题空串不落库', async () => {
  const sText = await createPublishedSurvey([{ type: 'text', title: '必答文本', required: true }]);
  assert.equal((await submit(sText.id, [{ questionId: sText.questions[0].id, value: '' }])).status, 400);
  const space = await submit(sText.id, [{ questionId: sText.questions[0].id, value: '   ' }]);
  assert.equal(space.status, 400);
  assert.match(space.data.error, /必答/);

  const sMulti = await createPublishedSurvey([{ type: 'multi', title: '必答多选', required: true, options: ['A', 'B'] }]);
  const emptyArr = await submit(sMulti.id, [{ questionId: sMulti.questions[0].id, value: [] }]);
  assert.equal(emptyArr.status, 400);
  assert.match(emptyArr.data.error, /必答/);

  const sOpt = await createPublishedSurvey([{ type: 'text', title: '可选文本', required: false }]);
  const ok = await submit(sOpt.id, [{ questionId: sOpt.questions[0].id, value: '' }]);
  assert.equal(ok.status, 201);
  const { getDb } = require('../src/db');
  const doc = await getDb().collection('responses').findOne({ surveyId: new ObjectId(sOpt.id) });
  assert.deepEqual(doc.answers, [], '可选题空串不应落库');
});

test('统计：多选选择次数、文本内容、数字平均值（真实答卷聚合）', async () => {
  const s = await createPublishedSurvey([MULTI, TEXT, NUMBER]);
  const [multi, text, num] = s.questions;
  // 两次提交：多选 [o0,o1] 与 [o0]；文本与数字各两次
  assert.equal((await submit(s.id, [
    { questionId: multi.id, value: [multi.options[0].id, multi.options[1].id] },
    { questionId: text.id, value: '第一份内容' },
    { questionId: num.id, value: 30 },
  ])).status, 201);
  assert.equal((await submit(s.id, [
    { questionId: multi.id, value: [multi.options[0].id] },
    { questionId: text.id, value: '第二份' },
    { questionId: num.id, value: 50 },
  ])).status, 201);

  const r = await h.req(ctx.base, `/api/stats/${s.id}`, { cookie: ownerCookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.totalResponses, 2);
  const byType = Object.fromEntries(r.data.questions.map((q) => [q.type, q]));

  const counts = Object.fromEntries(byType.multi.optionCounts.map((o) => [o.label, o.count]));
  assert.deepEqual(counts, { 跑步: 2, 游泳: 1, 骑行: 0 }, '多选：每份答卷对同一选项至多计一次');
  assert.equal(byType.multi.answered, 2);

  assert.deepEqual([...byType.text.contents].sort(), ['第一份内容', '第二份'].sort());

  assert.equal(byType.number.average, 40, '数字平均值 = (30+50)/2');
});
