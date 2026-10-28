// 题库题目与版本核心逻辑：
// - 创建：新建题目（v1）/ 从问卷存入题库（v1，剥离问卷局部结构）；
// - 版本：原子分配版本号（versionCount $inc）+ 不可变插入 + clientToken 幂等重试；
//   latestVersionNo 仅展示用（$max 更新 + 读取自愈），分配只依赖 versionCount；
// - 恢复 = 以历史版本为 parent 新建版本记录（完整历史链路）；
// - 删除：被任一问卷使用 → 409（T5）；未使用 → 先删版本再删主记录（幂等，可重试）；
// - 使用关系：由 surveys.questions.sourceQuestionId 多键索引派生，不建独立集合。
// 版本内容不含 jumps（jumps 是问卷局部结构，跨问卷无意义；快照进问卷时清空，T3）。
const { ObjectId } = require('mongodb');
const { getDb } = require('../db');
const { buildQuestion, validateSurveyStructure } = require('../validation');
const { effectiveStatus } = require('./lifecycle');

const questionsCol = () => getDb().collection('questions');
const versionsCol = () => getDb().collection('question_versions');

// 题库题目内容校验：复用问卷题目的构建（buildQuestion）与题型结构校验。
// existing = 基础版本 content（编辑新版本时回传旧选项 id 会被复用，保证选项 id 跨版本稳定）。
function validateQuestionContent(body, existing = null) {
  // base content 不含 _id（入库时剥离），但 buildQuestion 内部校验需要 _id → 补临时值
  const base = existing ? { _id: new ObjectId(), ...existing } : null;
  const { question, errors } = buildQuestion(body, base);
  if (errors.length) return { content: null, errors };
  const structureErrors = validateSurveyStructure({ questions: [question] });
  if (structureErrors.length) return { content: null, errors: structureErrors };
  const { _id, jumps, ...content } = question; // content 不含 _id / jumps
  return { content, errors: [] };
}

// 深拷贝版本内容并保证选项 _id 是 ObjectId 实例。
// 注意：不能 JSON.parse(JSON.stringify()) —— JSON 序列化会把 ObjectId 变成字符串，
// 后续 buildOptions 的 toHexString 调用与问卷快照的选项 id 类型都会出问题。
function cloneContent(content) {
  const out = { ...content };
  if (Array.isArray(content.options)) {
    out.options = content.options.map((o) => ({ _id: new ObjectId(String(o._id)), label: o.label }));
  }
  return out;
}

// 从问卷题目提取题库内容（存入题库用）：剥离 _id 与 jumps；选项 id 原样保留
function contentFromSurveyQuestion(q) {
  const content = {
    type: q.type,
    title: q.title,
    required: q.required === true,
    options: (q.options || []).map((o) => ({ _id: o._id, label: o.label })),
  };
  for (const field of ['minSelect', 'maxSelect', 'minLength', 'maxLength', 'minValue', 'maxValue', 'integerOnly']) {
    if (q[field] !== undefined && q[field] !== null) content[field] = q[field];
  }
  return content;
}

// 创建逻辑题目 + v1（版本内容不可变；口径标识 v1 自动生成）
async function insertQuestionAndV1({ bank, content, changeNote, caliberLabel, createdBy }) {
  const now = new Date();
  const result = await questionsCol().insertOne({
    ownerId: bank.ownerId,
    bankId: bank._id,
    type: content.type,
    title: content.title,
    latestVersionNo: 1,
    versionCount: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  await versionsCol().insertOne({
    questionId: result.insertedId,
    versionNo: 1,
    parentVersionNo: null,
    content,
    statsCaliber: { caliberKey: new ObjectId(), caliberLabel: (caliberLabel || '').trim() || '默认口径' },
    changeNote: (changeNote || '').trim(),
    createdBy: new ObjectId(createdBy),
    createdAt: now,
  });
  return result.insertedId;
}

// 原子分配版本号：$inc 保证并发下互不相同的号；失败不回退（空缺可接受，不复用）
async function allocateVersionNo(questionId) {
  const r = await questionsCol().findOneAndUpdate(
    { _id: questionId },
    { $inc: { versionCount: 1 } },
    { returnDocument: 'after' },
  );
  return r ? r.versionCount : null;
}

// 插入版本（幂等）：clientToken 唯一索引冲突时返回已存在的同一版本，防重试重复建版本
async function insertVersion(doc) {
  try {
    await versionsCol().insertOne(doc);
    return { ok: true, versionNo: doc.versionNo, idempotent: false };
  } catch (err) {
    if (err && err.code === 11000 && doc.clientToken) {
      const existing = await versionsCol().findOne({ questionId: doc.questionId, clientToken: doc.clientToken });
      if (existing) return { ok: true, versionNo: existing.versionNo, idempotent: true };
    }
    throw err;
  }
}

// latestVersionNo 自愈：以实际存在的版本为准（$max 幂等收敛）；仅展示字段，不影响分配
async function healLatestVersion(question) {
  const max = await versionsCol().findOne({ questionId: question._id }, { sort: { versionNo: -1 } });
  const actual = max ? max.versionNo : 0;
  if (actual > (question.latestVersionNo || 0)) {
    await questionsCol().updateOne({ _id: question._id }, { $max: { latestVersionNo: actual } });
    question.latestVersionNo = actual;
  }
}

function validateClientToken(clientToken) {
  if (clientToken === undefined || clientToken === null || clientToken === '') return { ok: true, value: null };
  if (typeof clientToken !== 'string' || clientToken.length === 0 || clientToken.length > 64) {
    return { ok: false, error: 'clientToken 必须是不超过 64 字符的非空字符串' };
  }
  return { ok: true, value: clientToken };
}

// 新建版本：content 以 base 版本为起点编辑；口径默认继承 base，caliberChanged 时生成新口径
async function createVersion(question, { baseVersionNo, body, changeNote, caliberChanged, caliberLabel, clientToken }, userId) {
  const tokenCheck = validateClientToken(clientToken);
  if (!tokenCheck.ok) return { ok: false, status: 400, error: tokenCheck.error };
  const baseNo = baseVersionNo === undefined || baseVersionNo === null || baseVersionNo === ''
    ? question.latestVersionNo : Number(baseVersionNo);
  const base = await versionsCol().findOne({ questionId: question._id, versionNo: baseNo });
  if (!base) return { ok: false, status: 404, error: '基础版本不存在' };
  const { content, errors } = validateQuestionContent(body, base.content);
  if (errors.length) return { ok: false, status: 400, error: errors.map((e) => e.message).join('；') };
  return allocateAndInsert(question, {
    parentVersionNo: base.versionNo,
    content,
    statsCaliber: caliberChanged === true
      ? { caliberKey: new ObjectId(), caliberLabel: (caliberLabel || '').trim() || '新口径' }
      : base.statsCaliber,
    changeNote,
    clientToken: tokenCheck.value,
  }, userId);
}

// 恢复历史版本 = 以该版本为 parent 新建版本记录（内容深拷贝，口径继承被恢复版本）
async function restoreVersion(question, versionNo, { changeNote, clientToken }, userId) {
  const tokenCheck = validateClientToken(clientToken);
  if (!tokenCheck.ok) return { ok: false, status: 400, error: tokenCheck.error };
  const target = await versionsCol().findOne({ questionId: question._id, versionNo: Number(versionNo) });
  if (!target) return { ok: false, status: 404, error: '版本不存在' };
  return allocateAndInsert(question, {
    parentVersionNo: target.versionNo,
    content: cloneContent(target.content), // 深拷贝且保持 ObjectId 类型，不共享引用
    statsCaliber: target.statsCaliber,
    changeNote: (changeNote || '').trim() || `恢复自 v${target.versionNo}`,
    clientToken: tokenCheck.value,
  }, userId);
}

async function allocateAndInsert(question, { parentVersionNo, content, statsCaliber, changeNote, clientToken }, userId) {
  const allocated = await allocateVersionNo(question._id);
  if (allocated === null) return { ok: false, status: 404, error: '题目不存在' };
  const doc = {
    questionId: question._id,
    versionNo: allocated,
    parentVersionNo,
    content,
    statsCaliber,
    changeNote: (changeNote || '').trim(),
    createdBy: new ObjectId(userId),
    createdAt: new Date(),
  };
  if (clientToken) doc.clientToken = clientToken;
  const result = await insertVersion(doc);
  // 版本已提交（不可回滚）；latestVersionNo 更新失败时由 healLatestVersion 自愈，不重复插入
  await questionsCol().updateOne(
    { _id: question._id },
    { $max: { latestVersionNo: doc.versionNo }, $set: { type: content.type, title: content.title, updatedAt: new Date() } },
  );
  return { ok: true, versionNo: result.versionNo, idempotent: result.idempotent };
}

// 删除逻辑题目：被任一问卷使用 → 409（T5，日常操作优先归档）；未使用 → 先删版本再删主记录。
// 删除顺序保证不产生"无主版本"孤立文档；主记录删除失败时重试本接口即可（第一步删 0 条，天然幂等）。
async function deleteQuestion(question) {
  const usageCount = await getDb().collection('surveys')
    .countDocuments({ 'questions.sourceQuestionId': question._id });
  if (usageCount > 0) return { ok: false, status: 409, error: '该题目已被问卷使用，不能删除（可改为归档）' };
  await versionsCol().deleteMany({ questionId: question._id });
  await questionsCol().deleteOne({ _id: question._id });
  return { ok: true };
}

// 使用关系（派生查询，无独立集合）：他人问卷标题隐藏（T2），仅返回状态/版本/时间
async function listUsages(question, userId) {
  const surveys = await getDb().collection('surveys')
    .find({ 'questions.sourceQuestionId': question._id })
    .toArray();
  const rows = [];
  for (const survey of surveys) {
    const own = survey.ownerId.toHexString() === String(userId);
    for (const q of survey.questions) {
      if (!q.sourceQuestionId || !q.sourceQuestionId.equals(question._id)) continue;
      rows.push({
        surveyId: survey._id.toHexString(),
        title: own ? survey.title : undefined,
        status: survey.status,
        effectiveStatus: effectiveStatus(survey),
        sourceVersionNo: q.sourceVersionNo,
        addedAt: q.addedAt,
        canViewStats: own,
      });
    }
  }
  rows.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  return rows;
}

module.exports = {
  validateQuestionContent,
  contentFromSurveyQuestion,
  insertQuestionAndV1,
  createVersion,
  restoreVersion,
  deleteQuestion,
  listUsages,
  healLatestVersion,
};
