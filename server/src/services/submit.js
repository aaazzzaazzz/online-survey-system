// 提交策略：状态/截止判断 → 答案校验 → 重复限制 → 保存答卷。
// 所有规则来自问卷字段（数据配置），不针对具体问卷写死。
const { ObjectId } = require('mongodb');
const { getDb } = require('../db');
const { QUESTION_TYPES } = require('./question-types');
const { validateAnswers, isEmptyAnswer } = require('./validate-answers');
const { openness } = require('./lifecycle');

async function submitResponse(survey, user, answers) {
  // 1. 生命周期判断（发布/关闭/截止三者分离，服务端惰性判断，无后台任务）
  const state = openness(survey);
  if (!state.open) return { ok: false, status: 403, errors: [state.reason] };

  // 2. 答案校验（题型规则由注册表提供）
  const errors = validateAnswers(survey, answers);
  if (errors.length) return { ok: false, status: 400, errors: errors.map((e) => e.message) };

  // 3. 身份与重复限制（Q1：匿名不记录 respondentId；Q6：不允许重复时拒绝第二次提交）
  const respondentId = survey.allowAnonymous ? null : new ObjectId(user._id);
  if (respondentId && !survey.allowRepeat) {
    // 应用层判重：正常重复请求在此得到明确的业务错误（409）
    const existing = await getDb().collection('responses').findOne({ surveyId: survey._id, respondentId });
    if (existing) return { ok: false, status: 409, errors: ['您已提交过该问卷，本问卷不允许重复填写'] };
  }

  // 4. 保存答卷：只保存有作答的题目；空答案（空串/纯空白/空数组）不落库（验收修复）；值按题型规范化。
  // repeatAllowed 冗余问卷的 allowRepeat 配置（B1 修复）：partial unique index
  // 无法引用 surveys 文档，跨文档唯一性条件必须冗余到答卷自身。
  const list = (Array.isArray(answers) ? answers : []).filter((a) => {
    const q = survey.questions.find((qq) => qq._id.toHexString() === String(a.questionId));
    return q && !isEmptyAnswer(q, a.value);
  });
  const doc = {
    surveyId: survey._id,
    respondentId,
    repeatAllowed: survey.allowRepeat === true,
    submittedAt: new Date(),
    answers: list.map((a) => {
      const q = survey.questions.find((qq) => qq._id.toHexString() === String(a.questionId));
      return { questionId: q._id, value: QUESTION_TYPES[q.type].normalizeValue(q, a.value) };
    }),
  };
  try {
    const result = await getDb().collection('responses').insertOne(doc);
    return { ok: true, responseId: result.insertedId.toHexString() };
  } catch (err) {
    // 并发兜底（B1）：两个同时到达的提交都通过上面判重时，partial unique index
    // 保证只有一个插入成功；另一个触发唯一索引冲突，转为明确的重复提交错误而非 500。
    if (err && err.code === 11000) {
      return { ok: false, status: 409, errors: ['您已提交过该问卷，本问卷不允许重复填写'] };
    }
    throw err;
  }
}

module.exports = { submitResponse };
