// 题型注册表：每种题型的字段构造、结构校验、答案校验、值规范化与统计实现集中在此。
// 新增题型只需在此登记（buildFromInput / validateStructure / validateAnswer /
// normalizeValue / buildStats），校验 / 提交 / 统计逻辑自动生效。
// 校验规则全部读取问卷（MongoDB）中的题目配置，不针对具体问卷写死。
const { ObjectId } = require('mongodb');

// 构造选项列表。编辑时（传入 existingOptions）仅当回传的 id 属于旧选项时复用，
// 其余生成新 id——删除被跳转引用的选项会让整卷结构校验明确报错，不留悬空引用。
function buildOptions(raw, existingOptions) {
  const oldById = new Map((existingOptions || []).map((o) => [o._id.toHexString(), o]));
  return (Array.isArray(raw) ? raw : []).map((o) => {
    const item = typeof o === 'string' ? { label: o } : (o || {});
    const label = String(item.label ?? '').trim();
    let id = null;
    if (item.id) {
      try {
        const oid = new ObjectId(String(item.id));
        if (oldById.has(oid.toHexString())) id = oid;
      } catch { /* 非法 id → 生成新 id */ }
    }
    return { _id: id || new ObjectId(), label };
  });
}

// 编辑界面数值字段：空 / 未填 → null（不限）；无法解析 → NaN（由结构校验报错）
function intOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

function numOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

const QUESTION_TYPES = {
  // 单选：value = 选项 id
  single: {
    buildFromInput(body, question, existing) {
      question.options = buildOptions(body.options, existing && existing.options);
    },
    validateStructure(q, errors) {
      const err = (message) => errors.push({ questionId: q._id.toHexString(), message });
      if (!Array.isArray(q.options) || q.options.length < 2) {
        err(`单选题「${q.title}」至少需要 2 个选项`);
        return;
      }
      const labels = q.options.map((o) => (typeof o.label === 'string' ? o.label.trim() : ''));
      if (labels.some((l) => l === '')) err(`单选题「${q.title}」选项文字不能为空`);
      if (new Set(labels).size !== labels.length) err(`单选题「${q.title}」选项文字不能重复`);
    },
    validateAnswer(q, value, errors) {
      const valid = typeof value === 'string' && q.options.some((o) => o._id.toHexString() === value);
      if (!valid) errors.push({ questionId: q._id.toHexString(), message: `单选题「${q.title}」：所选选项无效` });
    },
    normalizeValue(q, value) {
      return new ObjectId(value);
    },
    async buildStats(surveyId, q, responses) {
      // 各选项选择人数 = 答案 value 等于该选项 id 的答卷数（每份答卷每题至多一个答案）
      const rows = await responses.aggregate([
        { $match: { surveyId, 'answers.questionId': q._id } },
        { $unwind: '$answers' },
        { $match: { 'answers.questionId': q._id } },
        { $group: { _id: '$answers.value', count: { $sum: 1 } } },
      ]).toArray();
      const countByOption = new Map(rows.map((r) => [r._id.toHexString(), r.count]));
      return {
        optionCounts: q.options.map((o) => ({
          optionId: o._id.toHexString(),
          label: o.label,
          count: countByOption.get(o._id.toHexString()) || 0,
        })),
      };
    },
  },

  // 多选：value = 选项 id 数组；min == max 即"必须选择指定数量"
  multi: {
    buildFromInput(body, question, existing) {
      question.options = buildOptions(body.options, existing && existing.options);
      question.minSelect = intOrNull(body.minSelect);
      question.maxSelect = intOrNull(body.maxSelect);
    },
    validateStructure(q, errors) {
      const err = (message) => errors.push({ questionId: q._id.toHexString(), message });
      if (!Array.isArray(q.options) || q.options.length < 2) {
        err(`多选题「${q.title}」至少需要 2 个选项`);
        return;
      }
      const labels = q.options.map((o) => (typeof o.label === 'string' ? o.label.trim() : ''));
      if (labels.some((l) => l === '')) err(`多选题「${q.title}」选项文字不能为空`);
      if (new Set(labels).size !== labels.length) err(`多选题「${q.title}」选项文字不能重复`);
      const min = q.minSelect;
      const max = q.maxSelect;
      const intMin = Number.isInteger(min);
      const intMax = Number.isInteger(max);
      if (min !== null && !intMin) err(`多选题「${q.title}」最少选择数必须是非负整数`);
      if (max !== null && !intMax) err(`多选题「${q.title}」最多选择数必须是非负整数`);
      if (intMin && intMax && min > max) err(`多选题「${q.title}」最少选择数不能大于最多选择数`);
      if (intMin && min > q.options.length) err(`多选题「${q.title}」最少选择数不能超过选项数量（${q.options.length}）`);
      if (intMax && max > q.options.length) err(`多选题「${q.title}」最多选择数不能超过选项数量（${q.options.length}）`);
    },
    validateAnswer(q, value, errors) {
      const err = (message) => errors.push({ questionId: q._id.toHexString(), message });
      if (!Array.isArray(value)) {
        err(`多选题「${q.title}」：答案必须是选项 id 数组`);
        return;
      }
      if (new Set(value).size !== value.length) {
        err(`多选题「${q.title}」：不能重复选择同一选项`);
        return;
      }
      const invalid = value.filter((v) => typeof v !== 'string' || !q.options.some((o) => o._id.toHexString() === v));
      if (invalid.length) {
        err(`多选题「${q.title}」：存在无效选项`);
        return;
      }
      const n = value.length;
      if (Number.isInteger(q.minSelect) && n < q.minSelect) err(`多选题「${q.title}」：至少需选择 ${q.minSelect} 项，当前 ${n} 项`);
      if (Number.isInteger(q.maxSelect) && n > q.maxSelect) err(`多选题「${q.title}」：最多可选 ${q.maxSelect} 项，当前 ${n} 项`);
    },
    normalizeValue(q, value) {
      return value.map((v) => new ObjectId(v));
    },
    async buildStats(surveyId, q, responses) {
      // 各选项被选择次数：每份答卷对同一选项至多计 1 次（答卷内重复选项已被校验拒绝）
      const rows = await responses.aggregate([
        { $match: { surveyId, 'answers.questionId': q._id } },
        { $unwind: '$answers' },
        { $match: { 'answers.questionId': q._id } },
        { $unwind: '$answers.value' },
        { $group: { _id: '$answers.value', count: { $sum: 1 } } },
      ]).toArray();
      const countByOption = new Map(rows.map((r) => [r._id.toHexString(), r.count]));
      return {
        optionCounts: q.options.map((o) => ({
          optionId: o._id.toHexString(),
          label: o.label,
          count: countByOption.get(o._id.toHexString()) || 0,
        })),
      };
    },
  },

  // 文本：value = 字符串；字数按 Unicode 码点计
  text: {
    buildFromInput(body, question) {
      question.minLength = intOrNull(body.minLength);
      question.maxLength = intOrNull(body.maxLength);
    },
    validateStructure(q, errors) {
      const err = (message) => errors.push({ questionId: q._id.toHexString(), message });
      const min = q.minLength;
      const max = q.maxLength;
      if (min !== null && !Number.isInteger(min)) err(`文本题「${q.title}」最少字数必须是非负整数`);
      if (max !== null && !Number.isInteger(max)) err(`文本题「${q.title}」最多字数必须是非负整数`);
      if (Number.isInteger(min) && Number.isInteger(max) && min > max) err(`文本题「${q.title}」最少字数不能大于最多字数`);
    },
    validateAnswer(q, value, errors) {
      const err = (message) => errors.push({ questionId: q._id.toHexString(), message });
      if (typeof value !== 'string') {
        err(`文本题「${q.title}」：答案必须是字符串`);
        return;
      }
      const len = [...value].length;
      if (Number.isInteger(q.minLength) && len < q.minLength) err(`文本题「${q.title}」：至少 ${q.minLength} 字，当前 ${len} 字`);
      if (Number.isInteger(q.maxLength) && len > q.maxLength) err(`文本题「${q.title}」：最多 ${q.maxLength} 字，当前 ${len} 字`);
    },
    normalizeValue(q, value) {
      return value;
    },
    async buildStats(surveyId, q, responses) {
      // 填写内容列表（需求 1.6：填空的填写内容）
      const rows = await responses.aggregate([
        { $match: { surveyId, 'answers.questionId': q._id } },
        { $unwind: '$answers' },
        { $match: { 'answers.questionId': q._id } },
        { $project: { _id: 0, value: '$answers.value' } },
      ]).toArray();
      return { contents: rows.map((r) => r.value) };
    },
  },

  // 数字：value = 数值；double 存储，integerOnly 时先校验整数
  number: {
    buildFromInput(body, question) {
      question.minValue = numOrNull(body.minValue);
      question.maxValue = numOrNull(body.maxValue);
      question.integerOnly = body.integerOnly === true;
    },
    validateStructure(q, errors) {
      const err = (message) => errors.push({ questionId: q._id.toHexString(), message });
      const min = q.minValue;
      const max = q.maxValue;
      if (min !== null && !Number.isFinite(min)) err(`数字题「${q.title}」最小值必须是数字`);
      if (max !== null && !Number.isFinite(max)) err(`数字题「${q.title}」最大值必须是数字`);
      if (Number.isFinite(min) && Number.isFinite(max) && min > max) err(`数字题「${q.title}」最小值不能大于最大值`);
    },
    validateAnswer(q, value, errors) {
      const err = (message) => errors.push({ questionId: q._id.toHexString(), message });
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        err(`数字题「${q.title}」：答案必须是数字`);
        return;
      }
      if (q.integerOnly && !Number.isInteger(value)) err(`数字题「${q.title}」：必须填写整数`);
      if (Number.isFinite(q.minValue) && value < q.minValue) err(`数字题「${q.title}」：不能小于 ${q.minValue}`);
      if (Number.isFinite(q.maxValue) && value > q.maxValue) err(`数字题「${q.title}」：不能大于 ${q.maxValue}`);
    },
    normalizeValue(q, value) {
      return value;
    },
    async buildStats(surveyId, q, responses) {
      // 平均值：分母为该题作答人数（需求 1.6：数字平均值）
      const rows = await responses.aggregate([
        { $match: { surveyId, 'answers.questionId': q._id } },
        { $unwind: '$answers' },
        { $match: { 'answers.questionId': q._id } },
        { $group: { _id: null, average: { $avg: '$answers.value' } } },
      ]).toArray();
      return { average: rows.length ? rows[0].average : null };
    },
  },
};

module.exports = { QUESTION_TYPES };
