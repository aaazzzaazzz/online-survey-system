// 问卷管理：列表 / 创建 / 详情 / 修改标题说明 / 添加题目 / 发布。仅所有者可操作。
const express = require('express');
const { ObjectId } = require('mongodb');
const { getDb } = require('../db');
const { requireAuth } = require('../auth');
const { validateSurveyInput, buildQuestion, validateSurveyStructure } = require('../validation');
const { effectiveStatus } = require('../services/lifecycle');

const router = express.Router();
router.use(requireAuth);

function parseId(id) {
  try { return new ObjectId(id); } catch { return null; }
}

async function findOwned(idParam, userId) {
  const id = parseId(idParam);
  if (!id) return null;
  return getDb().collection('surveys').findOne({ _id: id, ownerId: new ObjectId(userId) });
}

function toPublic(survey) {
  return {
    id: survey._id.toHexString(),
    title: survey.title,
    description: survey.description,
    allowAnonymous: survey.allowAnonymous,
    allowRepeat: survey.allowRepeat,
    status: survey.status,
    closedAt: survey.closedAt,
    publishedAt: survey.publishedAt,
    deadline: survey.deadline,
    createdAt: survey.createdAt,
    updatedAt: survey.updatedAt,
    questions: survey.questions.map((q) => ({
      id: q._id.toHexString(),
      type: q.type,
      title: q.title,
      required: q.required,
      options: (q.options || []).map((o) => ({ id: o._id.toHexString(), label: o.label })),
      minSelect: q.minSelect ?? null,
      maxSelect: q.maxSelect ?? null,
      minLength: q.minLength ?? null,
      maxLength: q.maxLength ?? null,
      minValue: q.minValue ?? null,
      maxValue: q.maxValue ?? null,
      integerOnly: q.integerOnly === true,
      jumps: (q.jumps || []).map((j) => ({
        targetQuestionId: j.targetQuestionId ? j.targetQuestionId.toHexString() : String(j.targetQuestionId || ''),
        matchMode: j.matchMode || 'any',
        conditions: (j.conditions || []).map((c) => ({
          optionId: c.optionId ? c.optionId.toHexString() : c.optionId,
          optionIds: (c.optionIds || []).map((id) => (id && id.toHexString ? id.toHexString() : String(id))),
          op: c.op,
          value: c.value,
        })),
      })),
    })),
  };
}

// 我的问卷列表
router.get('/', async (req, res, next) => {
  try {
    const surveys = await getDb().collection('surveys')
      .find({ ownerId: new ObjectId(req.session.userId) })
      .sort({ updatedAt: -1 })
      .toArray();
    res.json(surveys.map((s) => ({
      id: s._id.toHexString(),
      title: s.title,
      status: s.status,
      effectiveStatus: effectiveStatus(s),
      deadline: s.deadline,
      questionCount: s.questions.length,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })));
  } catch (err) { next(err); }
});

// 创建问卷（草稿）
router.post('/', async (req, res, next) => {
  try {
    const { value, errors } = validateSurveyInput(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join('；') });
    const now = new Date();
    const doc = {
      ownerId: new ObjectId(req.session.userId),
      ...value,
      status: 'draft',
      publishedAt: null,
      deadline: null,
      questions: [],
      createdAt: now,
      updatedAt: now,
    };
    const result = await getDb().collection('surveys').insertOne(doc);
    res.status(201).json({ id: result.insertedId.toHexString() });
  } catch (err) { next(err); }
});

// 问卷详情
router.get('/:id', async (req, res, next) => {
  try {
    const survey = await findOwned(req.params.id, req.session.userId);
    if (!survey) return res.status(404).json({ error: '问卷不存在或无权访问' });
    res.json(toPublic(survey));
  } catch (err) { next(err); }
});

// 修改标题 / 说明 / 截止时间（Q5 已确认：发布后允许修改这三项；题目结构锁定）。
// 截止时间：前后端统一使用 ISO 8601 字符串（含时区），服务端解析后以 UTC Date 存储；null/空串 = 清除。
// 无效格式与过去时间被拒绝并给出明确错误；截止判断始终在服务端执行，不依赖前端显示状态。
router.patch('/:id', async (req, res, next) => {
  try {
    const survey = await findOwned(req.params.id, req.session.userId);
    if (!survey) return res.status(404).json({ error: '问卷不存在或无权访问' });
    const body = req.body || {};
    const allowed = ['title', 'description', 'deadline'];
    const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
    if (unknown.length) return res.status(400).json({ error: `仅允许修改：${allowed.join('、')}` });
    let deadline = survey.deadline;
    if ('deadline' in body) {
      if (body.deadline === null || body.deadline === '') {
        deadline = null;
      } else {
        const parsed = new Date(body.deadline);
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({ error: '截止时间格式无效（请使用 ISO 8601 时间字符串，如 2026-12-31T23:59:00+08:00）' });
        }
        if (parsed.getTime() <= Date.now()) return res.status(400).json({ error: '截止时间必须晚于当前时间' });
        deadline = parsed;
      }
    }
    const { value, errors } = validateSurveyInput({ ...survey, ...body });
    if (errors.length) return res.status(400).json({ error: errors.join('；') });
    await getDb().collection('surveys').updateOne(
      { _id: survey._id },
      { $set: { title: value.title, description: value.description, deadline, updatedAt: new Date() } },
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// 主动关闭已发布的问卷（仅创建者；不删除、不修改任何答卷）
router.post('/:id/close', async (req, res, next) => {
  try {
    const survey = await findOwned(req.params.id, req.session.userId);
    if (!survey) return res.status(404).json({ error: '问卷不存在或无权访问' });
    if (survey.status === 'draft') return res.status(400).json({ error: '未发布的问卷不能关闭' });
    if (survey.status === 'closed') return res.json({ status: 'closed' }); // 幂等
    await getDb().collection('surveys').updateOne(
      { _id: survey._id },
      { $set: { status: 'closed', closedAt: new Date(), updatedAt: new Date() } },
    );
    res.json({ status: 'closed' });
  } catch (err) { next(err); }
});

// 添加题目（仅草稿；发布后结构锁定 Q5）。
// 并发安全（E2E 实测发现原实现的读-改-写竞态会静默丢题）：
// 追加题目用"读取 → 校验 → 条件更新（updatedAt 守卫）"，守卫失败说明有并发写入抢先，重试。
router.post('/:id/questions', async (req, res, next) => {
  try {
    const ownerId = new ObjectId(req.session.userId);
    const initial = await getDb().collection('surveys').findOne({ _id: parseId(req.params.id), ownerId });
    if (!initial) return res.status(404).json({ error: '问卷不存在或无权访问' });
    if (initial.status !== 'draft') return res.status(409).json({ error: '问卷已发布，题目结构已锁定（Q5）' });
    const { question, errors } = buildQuestion(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.map((e) => e.message).join('；') });
    for (let attempt = 0; attempt < 5; attempt++) {
      const survey = await getDb().collection('surveys').findOne({ _id: initial._id, ownerId });
      if (!survey) return res.status(404).json({ error: '问卷不存在或无权访问' });
      if (survey.status !== 'draft') return res.status(409).json({ error: '问卷已发布，题目结构已锁定（Q5）' });
      const questions = [...survey.questions, question];
      const structureErrors = validateSurveyStructure({ ...survey, questions });
      if (structureErrors.length) {
        return res.status(400).json({ error: structureErrors.map((e) => e.message).join('；') });
      }
      const result = await getDb().collection('surveys').updateOne(
        { _id: survey._id, updatedAt: survey.updatedAt },
        { $set: { questions, updatedAt: new Date() } },
      );
      if (result.modifiedCount === 1) return res.status(201).json({ id: question._id.toHexString() });
    }
    res.status(409).json({ error: '操作冲突（并发修改），请重试' });
  } catch (err) { next(err); }
});

// 发布（需至少一道题）
router.post('/:id/publish', async (req, res, next) => {
  try {
    const survey = await findOwned(req.params.id, req.session.userId);
    if (!survey) return res.status(404).json({ error: '问卷不存在或无权访问' });
    if (survey.status !== 'draft') return res.status(400).json({ error: '问卷已发布或已关闭' });
    if (survey.questions.length < 1) return res.status(400).json({ error: '至少需要一道题目才能发布' });
    if (survey.deadline && new Date() > survey.deadline) {
      return res.status(400).json({ error: '截止时间已过，请先修改截止时间再发布' });
    }
    const structureErrors = validateSurveyStructure(survey);
    if (structureErrors.length) {
      return res.status(400).json({ error: structureErrors.map((e) => e.message).join('；') });
    }
    await getDb().collection('surveys').updateOne(
      { _id: survey._id },
      { $set: { status: 'published', publishedAt: new Date(), updatedAt: new Date() } },
    );
    res.json({ status: 'published' });
  } catch (err) { next(err); }
});

// 设置题目的跳转规则（仅草稿；发布后结构锁定 Q5）。
// 编辑器整体替换规则列表：添加/修改/删除/排序都映射为一次整体替换。
// 并发安全同添加题目：读取 → 校验 → 条件更新（updatedAt 守卫）→ 失败重试。
function toObjectIdOrKeep(value) {
  if (value === undefined || value === null || value === '') return value;
  try { return new ObjectId(String(value)); } catch { return value; }
}

router.put('/:id/questions/:qid/jumps', async (req, res, next) => {
  try {
    const ownerId = new ObjectId(req.session.userId);
    const qid = parseId(req.params.qid);
    const initial = await getDb().collection('surveys').findOne({ _id: parseId(req.params.id), ownerId });
    if (!initial) return res.status(404).json({ error: '问卷不存在或无权访问' });
    if (initial.status !== 'draft') return res.status(409).json({ error: '问卷已发布，题目结构已锁定（Q5）' });
    if (!initial.questions.some((q) => q._id.equals(qid))) return res.status(404).json({ error: '题目不存在' });

    // 规范化输入：id 转 ObjectId（非法值原样保留，由结构校验报错），matchMode 默认 any（Q2）
    const body = req.body || {};
    // matchMode 仅在缺省时默认 any（Q2）；显式传入非法值原样保留，由结构校验拒绝
    const jumps = (Array.isArray(body.jumps) ? body.jumps : []).map((r) => ({
      targetQuestionId: toObjectIdOrKeep(r && r.targetQuestionId),
      matchMode: r && (r.matchMode === undefined || r.matchMode === null || r.matchMode === '') ? 'any' : r.matchMode,
      conditions: (Array.isArray(r && r.conditions) ? r.conditions : []).map((c) => ({
        optionId: toObjectIdOrKeep(c.optionId),
        optionIds: Array.isArray(c.optionIds) ? c.optionIds.map(toObjectIdOrKeep) : c.optionIds,
        op: c.op,
        value: typeof c.value === 'number' ? c.value : Number(c.value),
      })),
    }));

    for (let attempt = 0; attempt < 5; attempt++) {
      const survey = await getDb().collection('surveys').findOne({ _id: initial._id, ownerId });
      if (!survey) return res.status(404).json({ error: '问卷不存在或无权访问' });
      if (survey.status !== 'draft') return res.status(409).json({ error: '问卷已发布，题目结构已锁定（Q5）' });
      const questions = survey.questions.map((q) => (q._id.equals(qid) ? { ...q, jumps } : q));
      const structureErrors = validateSurveyStructure({ ...survey, questions });
      if (structureErrors.length) {
        return res.status(400).json({ error: structureErrors.map((e) => e.message).join('；') });
      }
      const result = await getDb().collection('surveys').updateOne(
        { _id: survey._id, updatedAt: survey.updatedAt },
        { $set: { questions, updatedAt: new Date() } },
      );
      if (result.modifiedCount === 1) return res.json({ ok: true });
    }
    res.status(409).json({ error: '操作冲突（并发修改），请重试' });
  } catch (err) { next(err); }
});

module.exports = router;
