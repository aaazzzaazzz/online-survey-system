// 问卷与题目的结构校验（保存 / 发布时执行）。跳转规则（Q3/Q4 已确认）在数据层强制执行，
// 非法配置无法绕过前端进入数据库。
const { ObjectId } = require('mongodb');
const { QUESTION_TYPES } = require('./services/question-types');

const NUMBER_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'];
const JUMPABLE_TYPES = ['single', 'multi', 'number'];

// 创建 / 修改问卷的输入校验（标题必填；布尔字段未提供一律视为 false）
function validateSurveyInput(body) {
  const errors = [];
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title === '') errors.push('标题不能为空');
  return {
    value: {
      title,
      description: typeof body.description === 'string' ? body.description.trim() : '',
      allowAnonymous: body.allowAnonymous === true,
      allowRepeat: body.allowRepeat === true,
    },
    errors,
  };
}

function cloneJumps(jumps) {
  return (jumps || []).map((j) => ({
    targetQuestionId: j.targetQuestionId,
    matchMode: j.matchMode,
    conditions: (j.conditions || []).map((c) => ({
      optionId: c.optionId,
      optionIds: Array.isArray(c.optionIds) ? [...c.optionIds] : c.optionIds,
      op: c.op,
      value: c.value,
    })),
  }));
}

// 新增 / 编辑题目的输入校验（按题型注册表），返回规范化题目。
// 编辑（传入 existing）时：保留题目 _id 与既有跳转规则；选项 id 仅当回传 id 属于旧选项时复用
// （保证跳转引用稳定）；类型变更或选项变化导致跳转失效时，由整卷结构校验明确拒绝。
function buildQuestion(body, existing = null) {
  const errors = [];
  const type = body.type;
  const typeDef = QUESTION_TYPES[type];
  if (!typeDef) {
    return { question: null, errors: [{ questionId: null, message: `不支持的题型: ${type || '（空）'}` }] };
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title === '') errors.push({ questionId: null, message: '题干不能为空' });
  const question = existing
    ? { _id: existing._id, type, title, required: body.required === true, jumps: cloneJumps(existing.jumps) }
    : { _id: new ObjectId(), type, title, required: body.required === true };
  typeDef.buildFromInput(body, question, existing);
  typeDef.validateStructure(question, errors);
  if (errors.length) return { question: null, errors };
  return { question, errors };
}

function toHexId(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value;
  return value.toHexString ? value.toHexString() : String(value);
}

// 跳转规则校验：条件形态与题型匹配；目标必须存在且位于当前题之后（Q3/Q4）
function validateJumpRules(q, indexById, errors) {
  const err = (message) => errors.push({ questionId: q._id.toHexString(), message });
  if (!JUMPABLE_TYPES.includes(q.type)) {
    if ((q.jumps || []).length) err(`文本题「${q.title}」不支持跳转规则（仅单选/多选/数字可配置）`);
    return;
  }
  const optionIds = new Set((q.options || []).map((o) => o._id.toHexString()));
  for (const [i, jump] of (q.jumps || []).entries()) {
    const label = `「${q.title}」第 ${i + 1} 条跳转规则`;
    const targetId = toHexId(jump.targetQuestionId);
    const targetIndex = indexById.get(targetId);
    if (targetIndex === undefined) {
      err(`${label}：跳转目标不存在`);
    } else if (targetIndex <= indexById.get(q._id.toHexString())) {
      err(`${label}：只允许跳转到后面的题目（Q4）`);
    }
    const conditions = Array.isArray(jump.conditions) ? jump.conditions : [];
    if (conditions.length !== 1) {
      err(`${label}：必须且只能配置一个条件`);
      continue;
    }
    const cond = conditions[0] || {};
    if (q.type === 'single') {
      if (!optionIds.has(toHexId(cond.optionId))) err(`${label}：条件的选项无效`);
    } else if (q.type === 'multi') {
      if (!['any', 'all'].includes(jump.matchMode || 'any')) err(`${label}：多选匹配方式必须是 any 或 all`);
      const ids = Array.isArray(cond.optionIds) ? cond.optionIds : [];
      if (ids.length === 0) err(`${label}：条件至少包含一个选项`);
      else if (ids.some((id) => !optionIds.has(toHexId(id)))) err(`${label}：条件的选项无效`);
    } else if (q.type === 'number') {
      if (!NUMBER_OPS.includes(cond.op)) err(`${label}：比较运算符必须是 ${NUMBER_OPS.join('/')}`);
      if (typeof cond.value !== 'number' || !Number.isFinite(cond.value)) err(`${label}：比较值必须是数字`);
    }
  }
}

// 整卷结构校验（保存 / 发布前调用）：逐题按题型校验 + 跳转规则校验
function validateSurveyStructure(survey) {
  const errors = [];
  const indexById = new Map(survey.questions.map((q, i) => [q._id.toHexString(), i]));
  for (const q of survey.questions) {
    const typeDef = QUESTION_TYPES[q.type];
    if (!typeDef) {
      errors.push({ questionId: q._id.toHexString(), message: `不支持的题型: ${q.type}` });
      continue;
    }
    typeDef.validateStructure(q, errors);
    validateJumpRules(q, indexById, errors);
  }
  return errors;
}

module.exports = { validateSurveyInput, buildQuestion, validateSurveyStructure };
