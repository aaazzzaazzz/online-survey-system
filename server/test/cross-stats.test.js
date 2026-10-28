// 跨问卷统计测试（口径定稿表逐条钉死）：
// 合并规则 = 同一逻辑题目 + 快照 caliberKey 相同 + 内容签名相同（type/有序 label/约束）；
// 选项 id 变化不拆组（按 label 对齐）、title/required 变化不拆组；
// label 改变、选项顺序改变、约束改变、口径声明改变、内容变但声明未变（S4）均强制拆组；
// 数字合并加权（S2：均值=总和/总数，绝非平均各卷均值）；缺失口径（可选题跳过）；
// T1 隐私（仅本人问卷、他人问卷不纳入、共享用户只看自己的）；匿名问卷无身份字段；单版本查询。
process.env.MONGODB_DB = 'survey_system_test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let ctx;
let cookie, otherCookie, strangerCookie;

before(async () => {
  await h.resetTestDb();
  ctx = await h.startServer();
  cookie = await h.registerAndLogin(ctx.base, 'sowner');
  otherCookie = await h.registerAndLogin(ctx.base, 'sviewer');
  strangerCookie = await h.registerAndLogin(ctx.base, 'sstranger');
});
after(async () => { await h.stopServer(ctx); });

let bankId, qColor, qNumber, qMulti, qText;

async function createSurvey(cookieArg, title, allowAnonymous = false) {
  // 统计测试需要同一问卷多份答卷 → 允许重复填写
  const r = await h.req(ctx.base, '/api/surveys', { method: 'POST', cookie: cookieArg, body: { title, allowAnonymous, allowRepeat: true } });
  assert.equal(r.status, 201);
  return r.data.id;
}

async function fromBank(cookieArg, surveyId, qid, versionNo) {
  const r = await h.req(ctx.base, `/api/surveys/${surveyId}/questions/from-bank`, {
    method: 'POST', cookie: cookieArg, body: { bankQuestionId: qid, versionNo },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
}

async function publish(cookieArg, surveyId) {
  const r = await h.req(ctx.base, `/api/surveys/${surveyId}/publish`, { method: 'POST', cookie: cookieArg });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

async function submit(cookieArg, surveyId, answer) {
  const r = await h.req(ctx.base, `/api/fill/${surveyId}/submit`, { method: 'POST', cookie: cookieArg, body: { answers: answer } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
}

async function newVersion(qid, body, extra = {}) {
  const r = await h.req(ctx.base, `/api/questions/${qid}/versions`, { method: 'POST', cookie, body: { ...body, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.versionNo;
}

async function answerFor(cookieArg, surveyId, { label, skip = false } = {}) {
  const detail = await h.req(ctx.base, `/api/surveys/${surveyId}`, { cookie: cookieArg });
  const q = detail.data.questions[0];
  if (skip) return [];
  const opt = q.options.find((o) => o.label === label);
  return [{ questionId: q.id, value: opt.id }];
}

function countOf(group, label) {
  const row = (group.stats.optionCounts || []).find((o) => o.label === label);
  return row ? row.count : 0;
}

test('准备：题库 + 颜色题 6 个版本 + 数字/多选/文本题 + 各卷答卷', async () => {
  const b = await h.req(ctx.base, '/api/banks', { method: 'POST', cookie, body: { name: '统计题库' } });
  bankId = b.data.id;
  const make = async (body) => {
    const r = await h.req(ctx.base, `/api/banks/${bankId}/questions`, { method: 'POST', cookie, body });
    assert.equal(r.status, 201);
    return r.data.id;
  };

  // —— 颜色题：v1 基准；v2 改标题+选项 id 全新（同 label 应合并）；v3 改 label（应拆）；
  //    v4 内容同 v1 但声明新口径（单位改变，应拆）；v5 选项顺序反转（应拆）；v6 required 改 false（不拆）——
  qColor = await make({ type: 'single', title: '颜色', required: true, options: ['红', '蓝'] });
  await newVersion(qColor, { type: 'single', title: '颜色（改标题）', required: true, options: ['红', '蓝'] }); // v2
  await newVersion(qColor, { type: 'single', title: '颜色（换选项）', required: true, options: ['绿', '蓝'] }, { baseVersionNo: 1 }); // v3
  await newVersion(qColor, { type: 'single', title: '颜色', required: true, options: ['红', '蓝'] }, { baseVersionNo: 1, caliberChanged: true, caliberLabel: '华氏度' }); // v4
  await newVersion(qColor, { type: 'single', title: '颜色', required: true, options: ['蓝', '红'] }, { baseVersionNo: 1 }); // v5
  await newVersion(qColor, { type: 'single', title: '颜色', required: false, options: ['红', '蓝'] }, { baseVersionNo: 1 }); // v6

  const s1 = await createSurvey(cookie, 'S1-v1'); await fromBank(cookie, s1, qColor, 1); await publish(cookie, s1);
  await submit(cookie, s1, await answerFor(cookie, s1, { label: '红' }));
  await submit(cookie, s1, await answerFor(cookie, s1, { label: '蓝' }));
  const s2 = await createSurvey(cookie, 'S2-v2'); await fromBank(cookie, s2, qColor, 2); await publish(cookie, s2);
  await submit(cookie, s2, await answerFor(cookie, s2, { label: '红' }));
  const s3 = await createSurvey(cookie, 'S3-v3'); await fromBank(cookie, s3, qColor, 3); await publish(cookie, s3);
  await submit(cookie, s3, await answerFor(cookie, s3, { label: '绿' }));
  const s4 = await createSurvey(cookie, 'S4-v4'); await fromBank(cookie, s4, qColor, 4); await publish(cookie, s4);
  await submit(cookie, s4, await answerFor(cookie, s4, { label: '红' }));
  const s5 = await createSurvey(cookie, 'S5-v5'); await fromBank(cookie, s5, qColor, 5); await publish(cookie, s5);
  await submit(cookie, s5, await answerFor(cookie, s5, { label: '红' }));
  const s6 = await createSurvey(cookie, 'S6-v6'); await fromBank(cookie, s6, qColor, 6); await publish(cookie, s6);
  await submit(cookie, s6, await answerFor(cookie, s6, { label: '红' }));
  await submit(cookie, s6, await answerFor(cookie, s6, { skip: true })); // 可选题跳过 → 缺失口径
  const s7 = await createSurvey(cookie, 'S7-v1-匿名', true); await fromBank(cookie, s7, qColor, 1); await publish(cookie, s7);
  await submit(cookie, s7, await answerFor(cookie, s7, { label: '红' }));
  await submit(cookie, s7, await answerFor(cookie, s7, { label: '红' }));

  // —— 数字题：v1/v2 仅标题不同（应合并加权）——
  qNumber = await make({ type: 'number', title: '年龄', required: true, minValue: 0, maxValue: 120, integerOnly: true });
  await newVersion(qNumber, { type: 'number', title: '年龄（改标题）', required: true, minValue: 0, maxValue: 120, integerOnly: true }); // v2
  const n1 = await createSurvey(cookie, 'N1'); await fromBank(cookie, n1, qNumber, 1); await publish(cookie, n1);
  await submit(cookie, n1, [{ questionId: (await h.req(ctx.base, `/api/surveys/${n1}`, { cookie })).data.questions[0].id, value: 2 }]);
  await submit(cookie, n1, [{ questionId: (await h.req(ctx.base, `/api/surveys/${n1}`, { cookie })).data.questions[0].id, value: 4 }]);
  const n2 = await createSurvey(cookie, 'N2'); await fromBank(cookie, n2, qNumber, 2); await publish(cookie, n2);
  await submit(cookie, n2, [{ questionId: (await h.req(ctx.base, `/api/surveys/${n2}`, { cookie })).data.questions[0].id, value: 10 }]);

  // —— 多选题：v1/v2 选项 id 不同、label 相同（应合并按 label 对齐）——
  qMulti = await make({ type: 'multi', title: '水果', required: true, options: ['苹果', '香蕉'] });
  await newVersion(qMulti, { type: 'multi', title: '水果', required: true, options: ['苹果', '香蕉'] }); // v2（新 id）
  const m1 = await createSurvey(cookie, 'M1'); await fromBank(cookie, m1, qMulti, 1); await publish(cookie, m1);
  {
    const d = await h.req(ctx.base, `/api/surveys/${m1}`, { cookie });
    const q = d.data.questions[0];
    const ids = q.options.map((o) => o.id);
    await submit(cookie, m1, [{ questionId: q.id, value: ids }]);
  }
  const m2 = await createSurvey(cookie, 'M2'); await fromBank(cookie, m2, qMulti, 2); await publish(cookie, m2);
  {
    const d = await h.req(ctx.base, `/api/surveys/${m2}`, { cookie });
    const q = d.data.questions[0];
    await submit(cookie, m2, [{ questionId: q.id, value: [q.options[0].id] }]);
  }

  // —— 文本题 ——
  qText = await make({ type: 'text', title: '建议', required: false });
  const t1 = await createSurvey(cookie, 'T1'); await fromBank(cookie, t1, qText, 1); await publish(cookie, t1);
  const tq = (await h.req(ctx.base, `/api/surveys/${t1}`, { cookie })).data.questions[0].id;
  await submit(cookie, t1, [{ questionId: tq, value: '你好' }]);
  await submit(cookie, t1, [{ questionId: tq, value: '世界' }]);

  // —— 共享用户使用同一题目（不得进入 owner 的跨问卷统计，T1）——
  await h.req(ctx.base, `/api/banks/${bankId}/share`, { method: 'POST', cookie, body: { username: 'sviewer' } });
  const sx = await createSurvey(otherCookie, '他人的问卷');
  await fromBank(otherCookie, sx, qColor, 1);
  await publish(otherCookie, sx);
  await submit(otherCookie, sx, await answerFor(otherCookie, sx, { label: '红' }));
});

test('合并规则：v1+v2+v6 合并一组（title/选项 id/required 变化不拆组）；v3/v4/v5 各自拆组', async () => {
  const r = await h.req(ctx.base, `/api/questions/${qColor}/cross-stats`, { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.groups.length, 4, '应有 4 个分组：合并组 A（v1/v2/v6）与 v3/v4/v5 各一组');

  const groupA = r.data.groups.find((g) => g.compatibleVersionNos.includes(1) && g.compatibleVersionNos.includes(2));
  assert.ok(groupA, '应存在 v1/v2 合并组');
  assert.deepEqual([...groupA.compatibleVersionNos].sort((a, b) => a - b), [1, 2, 6], 'title/选项id/required 变化不拆组');
  assert.equal(groupA.merged, true);
  assert.equal(countOf(groupA, '红'), 5, '红 = S1 1 + S2 1 + S6 1 + S7 2');
  assert.equal(countOf(groupA, '蓝'), 1, '蓝 = S1 1');
  assert.equal(groupA.surveyCount, 4, 'S1/S2/S6/S7 四卷');
  assert.equal(groupA.totalResponses, 7, '2+1+2+2');
  assert.equal(groupA.answered, 6);
  assert.equal(groupA.missing, 1, 'S6 可选题跳过 1 份');
  assert.ok(groupA.missingExplanation.includes('未作答'), '应说明缺失口径');

  // v3（label 改变、声明口径未变）→ 强制拆组（S4）
  const g3 = r.data.groups.find((g) => g.compatibleVersionNos.includes(3));
  assert.ok(g3, 'v3 应单独成组');
  assert.equal(g3.merged, false);
  assert.equal(g3.caliberKey, groupA.caliberKey, 'v3 声明口径与 v1 相同');
  assert.notEqual(g3.signature, groupA.signature, '但内容签名不同 → 拆组');
  assert.equal(countOf(g3, '绿'), 1);

  // v4（内容相同、声明新口径 = 单位改变）→ 拆组
  const g4 = r.data.groups.find((g) => g.compatibleVersionNos.includes(4));
  assert.ok(g4, 'v4 应单独成组');
  assert.notEqual(g4.caliberKey, groupA.caliberKey, '新口径应拆组');
  assert.equal(g4.caliberLabel, '华氏度');
  assert.equal(countOf(g4, '红'), 1);

  // v5（选项顺序改变）→ 拆组
  const g5 = r.data.groups.find((g) => g.compatibleVersionNos.includes(5));
  assert.ok(g5, '选项顺序改变应拆组');
  assert.equal(countOf(g5, '红'), 1);
});

test('数字合并加权：均值 = 总和/总数（16/3），绝非平均各卷均值（6.5）', async () => {
  const r = await h.req(ctx.base, `/api/questions/${qNumber}/cross-stats`, { cookie });
  assert.equal(r.data.groups.length, 1, '数字题 v1/v2 仅标题不同应合并');
  const g = r.data.groups[0];
  assert.equal(g.stats.number.count, 3);
  assert.ok(Math.abs(g.stats.number.mean - 16 / 3) < 1e-9, `加权均值应为 16/3，实际 ${g.stats.number.mean}`);
  assert.notEqual(g.stats.number.mean, 6.5, '不得平均各卷均值');
  assert.equal(g.stats.number.min, 2);
  assert.equal(g.stats.number.max, 10);
});

test('多选跨卷合并：选项 id 不同但 label 相同 → 按 label 对齐相加', async () => {
  const r = await h.req(ctx.base, `/api/questions/${qMulti}/cross-stats`, { cookie });
  assert.equal(r.data.groups.length, 1);
  assert.equal(countOf(r.data.groups[0], '苹果'), 2);
  assert.equal(countOf(r.data.groups[0], '香蕉'), 1);
});

test('文本题合并：返回带来源（surveyId/submittedAt）的内容列表', async () => {
  const r = await h.req(ctx.base, `/api/questions/${qText}/cross-stats`, { cookie });
  assert.equal(r.data.groups.length, 1);
  const contents = r.data.groups[0].stats.contents;
  assert.equal(contents.length, 2);
  assert.deepEqual(contents.map((c) => c.value).sort(), ['世界', '你好']);
  for (const c of contents) {
    assert.ok(c.surveyId && c.submittedAt, '文本内容应带来源问卷与提交时间');
  }
});

test('单版本查询：?versionNo=1 只统计使用 v1 的问卷', async () => {
  const r = await h.req(ctx.base, `/api/questions/${qColor}/cross-stats?versionNo=1`, { cookie });
  const g = r.data.groups[0];
  assert.deepEqual(g.compatibleVersionNos, [1]);
  assert.equal(g.surveyCount, 2, 'S1 与 S7（匿名卷）');
  assert.equal(countOf(g, '红'), 3, 'S1 1 + S7 2');
  assert.equal(countOf(g, '蓝'), 1);
  assert.equal(g.totalResponses, 4);
});

test('T1 隐私：owner 的统计不含他人问卷；共享用户只看自己的；无关用户 404', async () => {
  const r = await h.req(ctx.base, `/api/questions/${qColor}/cross-stats`, { cookie });
  const allUnits = r.data.groups.flatMap((g) => g.units);
  assert.ok(!allUnits.some((u) => u.title === '他人的问卷'), '不得纳入他人问卷');
  assert.ok(!JSON.stringify(r.data).includes('他人的问卷'));

  const viewer = await h.req(ctx.base, `/api/questions/${qColor}/cross-stats`, { cookie: otherCookie });
  assert.equal(viewer.status, 200);
  assert.equal(viewer.data.groups.length, 1);
  assert.equal(viewer.data.groups[0].surveyCount, 1, '共享用户只能看到自己的 1 份问卷');
  assert.equal(viewer.data.groups[0].units[0].title, '他人的问卷', '自己的问卷标题可见');
  assert.equal(countOf(viewer.data.groups[0], '红'), 1);

  const denied = await h.req(ctx.base, `/api/questions/${qColor}/cross-stats`, { cookie: strangerCookie });
  assert.equal(denied.status, 404);
});

test('匿名问卷：统计正常且响应不含任何身份字段', async () => {
  const r = await h.req(ctx.base, `/api/questions/${qColor}/cross-stats?versionNo=1`, { cookie });
  const text = JSON.stringify(r.data);
  assert.ok(!text.includes('respondentId') && !text.includes('respondent'), '统计响应不得包含答卷身份信息');
  const g = r.data.groups[0];
  assert.equal(countOf(g, '红'), 3, '匿名卷 2 份红 + S1 1 份红');
});
