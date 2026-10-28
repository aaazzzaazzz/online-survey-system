// 跨问卷统计（T1 已确认：仅聚合请求者本人的问卷）。
// 分组判定完全以问卷快照为准：组键 = 快照 sourceCaliberKey（添加时拷贝的显式口径声明）
// + 快照内容签名（type / 有序选项 label / 校验约束）。不 join 版本文档做判定。
// 规则：口径声明只能拆组（单位/概念改变），不能强行合并；内容签名不同必然拆组（选项含义、
// 顺序、约束、题型改变）；title / required / jumps / 选项 id 不参与签名。
// 数字合并为跨卷原始答案聚合（均值 = 总和 / 总数），绝不平均各卷均值。
const { getDb } = require('../db');

// 统计语义签名：不含 title/required/jumps/选项 id/时间（定稿表见本轮设计补充 §2）
function statsSignature(q) {
  const parts = [q.type, JSON.stringify((q.options || []).map((o) => o.label))];
  if (q.type === 'multi') parts.push(q.minSelect ?? null, q.maxSelect ?? null);
  if (q.type === 'text') parts.push(q.minLength ?? null, q.maxLength ?? null);
  if (q.type === 'number') parts.push(q.minValue ?? null, q.maxValue ?? null, q.integerOnly === true);
  return JSON.stringify(parts);
}

async function computeCrossStats(question, userId, { versionNo } = {}) {
  const responses = getDb().collection('responses');
  const surveys = await getDb().collection('surveys')
    .find({ ownerId: new (require('mongodb').ObjectId)(userId), 'questions.sourceQuestionId': question._id })
    .toArray();
  // 使用单元 =（问卷, 内嵌题目快照）；同一问卷多次使用同一题库题时按份计（口径在文档中说明）
  const units = [];
  for (const survey of surveys) {
    for (const q of survey.questions) {
      if (!q.sourceQuestionId || !q.sourceQuestionId.equals(question._id)) continue;
      if (versionNo !== undefined && versionNo !== null && q.sourceVersionNo !== Number(versionNo)) continue;
      units.push({ survey, q });
    }
  }
  const groups = new Map();
  for (const { survey, q } of units) {
    const caliberKey = q.sourceCaliberKey ? q.sourceCaliberKey.toHexString() : '';
    const signature = statsSignature(q);
    const key = `${caliberKey}::${signature}`;
    if (!groups.has(key)) groups.set(key, { caliberKey: q.sourceCaliberKey || null, signature, units: [] });
    groups.get(key).units.push({ survey, q });
  }
  const result = [];
  for (const group of groups.values()) {
    result.push(await buildGroup(question, group, responses));
  }
  return { questionId: question._id.toHexString(), title: question.title, groups: result };
}

async function buildGroup(question, group, responses) {
  const versionNos = [...new Set(group.units.map((u) => u.q.sourceVersionNo))].sort((a, b) => a - b);
  const firstQ = group.units[0].q;
  const unitsOut = [];
  let totalResponses = 0;
  let answered = 0;
  let nSum = 0;
  let nCount = 0;
  let nMin = null;
  let nMax = null;
  const optionCounts = new Map(); // label -> count（跨问卷按 label 对齐，选项 id 不参与）
  const contents = [];

  for (const { survey, q } of group.units) {
    const responseCount = await responses.countDocuments({ surveyId: survey._id });
    const answeredCount = await responses.countDocuments({ surveyId: survey._id, 'answers.questionId': q._id });
    totalResponses += responseCount;
    answered += answeredCount;
    unitsOut.push({
      surveyId: survey._id.toHexString(),
      title: survey.title,
      status: survey.status,
      sourceVersionNo: q.sourceVersionNo,
      addedAt: q.addedAt,
      responseCount,
      answeredCount,
      missingCount: responseCount - answeredCount,
    });
    const labelById = new Map((q.options || []).map((o) => [o._id.toHexString(), o.label]));
    const rows = await responses.aggregate([
      { $match: { surveyId: survey._id, 'answers.questionId': q._id } },
      { $unwind: '$answers' },
      { $match: { 'answers.questionId': q._id } },
    ]).toArray();
    if (q.type === 'single') {
      for (const r of rows) {
        const label = labelById.get(r.answers.value.toHexString());
        if (label !== undefined) optionCounts.set(label, (optionCounts.get(label) || 0) + 1);
      }
    } else if (q.type === 'multi') {
      for (const r of rows) {
        for (const v of r.answers.value) {
          const label = labelById.get(v.toHexString());
          if (label !== undefined) optionCounts.set(label, (optionCounts.get(label) || 0) + 1);
        }
      }
    } else if (q.type === 'text') {
      for (const r of rows) {
        contents.push({ surveyId: survey._id.toHexString(), submittedAt: r.submittedAt, value: r.answers.value });
      }
    } else if (q.type === 'number') {
      for (const r of rows) {
        const v = r.answers.value;
        if (typeof v !== 'number') continue;
        nSum += v;
        nCount += 1;
        if (nMin === null || v < nMin) nMin = v;
        if (nMax === null || v > nMax) nMax = v;
      }
    }
  }

  const stats = {};
  if (firstQ.type === 'single' || firstQ.type === 'multi') {
    stats.optionCounts = [...optionCounts.entries()].map(([label, count]) => ({ label, count }));
  } else if (firstQ.type === 'text') {
    stats.contents = contents;
  } else if (firstQ.type === 'number') {
    stats.number = { count: nCount, mean: nCount ? nSum / nCount : null, min: nMin, max: nMax };
  }
  return {
    caliberKey: group.caliberKey ? group.caliberKey.toHexString() : null,
    caliberLabel: await resolveCaliberLabel(question, versionNos),
    signature: group.signature,
    compatibleVersionNos: versionNos,
    merged: versionNos.length > 1,
    surveyCount: group.units.length,
    totalResponses,
    answered,
    missing: totalResponses - answered,
    missingExplanation: '未作答 = 各卷答卷数 − 该题作答数（题目被跳过或可选题未作答；必答题为 0）。',
    units: unitsOut,
    stats,
  };
}

// 口径标签展示用：从版本记录解析（版本不可变且使用中题目不可删，解析必然成功）
async function resolveCaliberLabel(question, versionNos) {
  if (!versionNos.length) return null;
  const version = await getDb().collection('question_versions').findOne(
    { questionId: question._id, versionNo: versionNos[0] },
    { projection: { statsCaliber: 1 } },
  );
  return version && version.statsCaliber ? version.statsCaliber.caliberLabel : null;
}

module.exports = { computeCrossStats, statsSignature };
