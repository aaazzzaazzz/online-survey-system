// 答案校验（服务端最终校验，不信任前端顺序与跳转结果）：
// 1. 按已提交答案与题目跳转规则重新计算合法填写路径；
// 2. 路径上已答的题按题型注册表校验；
// 3. 路径上未答的必答题报错；被跳过/未到达的题一律不得有答案（防伪造路径、保证不混入统计）。
const { QUESTION_TYPES } = require('./question-types');
const { resolvePath } = require('./resolve-jumps');

// 空答案（null/undefined、纯空白文本、空多选数组）视为未作答：
// 必答题由"必答"校验拦截；可选题不落库（最终验收发现并修复）。
function isEmptyAnswer(q, value) {
  if (value === undefined || value === null) return true;
  if (q.type === 'text' && typeof value === 'string' && value.trim() === '') return true;
  if (q.type === 'multi' && Array.isArray(value) && value.length === 0) return true;
  return false;
}

function validateAnswers(survey, answers) {
  const errors = [];
  const byId = new Map(survey.questions.map((q) => [q._id.toHexString(), q]));
  const valueById = new Map();
  for (const a of Array.isArray(answers) ? answers : []) {
    const qid = String(a && a.questionId);
    if (!byId.has(qid)) {
      errors.push({ questionId: qid, message: '提交了问卷中不存在的题目' });
      continue;
    }
    if (valueById.has(qid)) {
      errors.push({ questionId: qid, message: `题目「${byId.get(qid).title}」不能提交多个答案` });
      continue;
    }
    if (isEmptyAnswer(byId.get(qid), a.value)) continue; // 空答案视为未作答
    valueById.set(qid, a.value);
  }

  const { path, status, currentIndex } = resolvePath(survey, valueById);
  const onPath = new Set(path.map((i) => survey.questions[i]._id.toHexString()));

  // 路径外（被跳过/未到达）的题不得有答案——客户端伪造跳转路径在此被拒绝
  for (const qid of valueById.keys()) {
    if (!onPath.has(qid)) {
      errors.push({ questionId: qid, message: `题目「${byId.get(qid).title}」不在有效填写路径上（已被跳过或未到达）` });
    }
  }

  // 路径上已答的题按题型校验
  for (const i of path) {
    const q = survey.questions[i];
    QUESTION_TYPES[q.type].validateAnswer(q, valueById.get(q._id.toHexString()), errors);
  }

  // 未完成时，第一道未作答的题若是必答则报错（可选题允许不答直接提交）
  if (status === 'incomplete') {
    const q = survey.questions[currentIndex];
    if (q.required) errors.push({ questionId: q._id.toHexString(), message: `必答题未作答：${q.title}` });
  }
  return errors;
}

module.exports = { validateAnswers, isEmptyAnswer };
