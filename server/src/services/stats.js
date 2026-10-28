// 统计口径：直接聚合 responses（docs/database.md §8：不做统计缓存），
// 各题型统计由题型注册表提供实现。
const { getDb } = require('../db');
const { QUESTION_TYPES } = require('./question-types');

async function computeStats(survey) {
  const responses = getDb().collection('responses');
  const totalResponses = await responses.countDocuments({ surveyId: survey._id });
  const questions = [];
  for (const q of survey.questions) {
    // 该题回答人数 = 含该题答案的答卷数（被跳过的题不会出现在答案中）
    const answered = await responses.countDocuments({ surveyId: survey._id, 'answers.questionId': q._id });
    const typeDef = QUESTION_TYPES[q.type];
    const stats = typeDef && typeDef.buildStats ? await typeDef.buildStats(survey._id, q, responses) : {};
    questions.push({
      questionId: q._id.toHexString(),
      type: q.type,
      title: q.title,
      answered,
      ...stats,
    });
  }
  return { surveyId: survey._id.toHexString(), title: survey.title, totalResponses, questions };
}

module.exports = { computeStats };
