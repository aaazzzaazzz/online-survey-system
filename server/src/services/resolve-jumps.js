// 跳转解析：根据题目 jumps 配置（数据驱动，存于 MongoDB 问卷文档）与已提交答案
// 计算合法填写路径。规则按数组顺序求值，首条命中生效（Q3）；未命中按题目顺序继续。
// 服务端在提交时重新计算路径，不信任客户端传来的顺序或跳转结果。

function toHexId(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value;
  return value.toHexString ? value.toHexString() : String(value);
}

// 单条规则是否命中（按题型比较条件；容忍条件以字符串或 ObjectId 存储）
function ruleMatches(question, rule, answer) {
  const cond = (rule.conditions || [])[0];
  if (!cond) return false;
  if (question.type === 'single') {
    return typeof answer === 'string' && toHexId(cond.optionId) === answer;
  }
  if (question.type === 'multi') {
    if (!Array.isArray(answer)) return false;
    const mode = rule.matchMode === 'all' ? 'all' : 'any'; // 默认 any（Q2）
    const ids = (cond.optionIds || []).map(toHexId);
    if (mode === 'any') return answer.some((id) => ids.includes(id));
    return ids.every((id) => answer.includes(id));
  }
  if (question.type === 'number') {
    if (typeof answer !== 'number') return false;
    const v = cond.value;
    switch (cond.op) {
      case 'eq': return answer === v;
      case 'ne': return answer !== v;
      case 'lt': return answer < v;
      case 'lte': return answer <= v;
      case 'gt': return answer > v;
      case 'gte': return answer >= v;
      default: return false;
    }
  }
  return false;
}

// 命中则返回目标题在 questions 中的下标；未命中返回 null（按顺序下一题）
function resolveJumpTarget(question, answer, indexById) {
  for (const rule of question.jumps || []) {
    if (ruleMatches(question, rule, answer)) {
      return indexById.get(toHexId(rule.targetQuestionId));
    }
  }
  return null;
}

// 从第 0 题开始按答案与跳转规则模拟填写路径。
// 返回 { path: [位于路径上且已作答的题目下标], status: 'incomplete' | 'complete', currentIndex }
// incomplete 时 currentIndex 为第一道未作答的题（即当前题）；complete 表示已走到最后（可提交）。
function resolvePath(survey, answersById) {
  const indexById = new Map(survey.questions.map((q, i) => [q._id.toHexString(), i]));
  const path = [];
  let index = 0;
  while (index < survey.questions.length) {
    const q = survey.questions[index];
    const answer = answersById.get(q._id.toHexString());
    if (answer === undefined) return { path, status: 'incomplete', currentIndex: index };
    path.push(index);
    const target = resolveJumpTarget(q, answer, indexById);
    index = target !== null && target !== undefined ? target : index + 1;
  }
  return { path, status: 'complete', currentIndex: null };
}

module.exports = { ruleMatches, resolveJumpTarget, resolvePath };
