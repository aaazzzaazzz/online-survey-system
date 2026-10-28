// 题库管理：列表（我的 / 共享给我的）、创建、详情、改名、删除（非空 409）、
// 共享（按用户名授予，T4 首期只读）、题目列表、新建题目（v1）、从问卷存入题库（v1）。
const express = require('express');
const { ObjectId } = require('mongodb');
const { getDb } = require('../db');
const { requireAuth } = require('../auth');
const { getBankAccess } = require('../services/bank-access');
const {
  validateQuestionContent,
  contentFromSurveyQuestion,
  insertQuestionAndV1,
} = require('../services/question-versions');
const { validateSurveyStructure } = require('../validation');

const router = express.Router();
router.use(requireAuth);

function parseId(id) { try { return new ObjectId(id); } catch { return null; } }

async function findBankWithAccess(idParam, userId) {
  const id = parseId(idParam);
  if (!id) return { bank: null, access: 'none' };
  const bank = await getDb().collection('question_banks').findOne({ _id: id });
  return { bank, access: getBankAccess(bank, userId) };
}

// 共享列表附带用户名（仅展示用）
async function withUsernames(sharedWith) {
  const ids = (sharedWith || []).map((s) => s.userId);
  if (!ids.length) return [];
  const users = await getDb().collection('users').find({ _id: { $in: ids } }, { projection: { username: 1 } }).toArray();
  const nameById = new Map(users.map((u) => [u._id.toHexString(), u.username]));
  return (sharedWith || []).map((s) => ({
    userId: s.userId.toHexString(),
    username: nameById.get(s.userId.toHexString()) || null,
    canEdit: s.canEdit === true,
    grantedAt: s.grantedAt,
  }));
}

function toPublic(bank, role) {
  return {
    id: bank._id.toHexString(),
    name: bank.name,
    description: bank.description,
    role,
    createdAt: bank.createdAt,
    updatedAt: bank.updatedAt,
  };
}

// 我的题库 + 共享给我的题库
router.get('/', async (req, res, next) => {
  try {
    const uid = new ObjectId(req.session.userId);
    const banks = getDb().collection('question_banks');
    const mine = await banks.find({ ownerId: uid }).sort({ updatedAt: -1 }).toArray();
    const shared = await banks.find({ 'sharedWith.userId': uid }).sort({ updatedAt: -1 }).toArray();
    res.json({
      mine: mine.map((b) => toPublic(b, 'owner')),
      sharedWithMe: shared.map((b) => toPublic(b, 'viewer')),
    });
  } catch (err) { next(err); }
});

// 创建题库（T6：用户手动创建，不自动创建默认题库）
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '') return res.status(400).json({ error: '题库名称不能为空' });
    if ([...name].length > 50) return res.status(400).json({ error: '题库名称不能超过 50 个字符' });
    const now = new Date();
    const doc = {
      ownerId: new ObjectId(req.session.userId),
      name,
      description: typeof body.description === 'string' ? body.description.trim() : '',
      sharedWith: [],
      scope: 'personal',
      createdAt: now,
      updatedAt: now,
    };
    const result = await getDb().collection('question_banks').insertOne(doc);
    res.status(201).json({ id: result.insertedId.toHexString() });
  } catch (err) { next(err); }
});

// 题库详情：共享列表仅所有者可见
router.get('/:id', async (req, res, next) => {
  try {
    const { bank, access } = await findBankWithAccess(req.params.id, req.session.userId);
    if (!bank || access === 'none') return res.status(404).json({ error: '题库不存在或无权访问' });
    const out = toPublic(bank, access);
    if (access === 'owner') out.sharedWith = await withUsernames(bank.sharedWith);
    res.json(out);
  } catch (err) { next(err); }
});

// 改名 / 改说明（仅所有者）
router.patch('/:id', async (req, res, next) => {
  try {
    const { bank, access } = await findBankWithAccess(req.params.id, req.session.userId);
    if (!bank || access === 'none') return res.status(404).json({ error: '题库不存在或无权访问' });
    if (access !== 'owner') return res.status(403).json({ error: '仅题库所有者可修改' });
    const body = req.body || {};
    const allowed = ['name', 'description'];
    const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
    if (unknown.length) return res.status(400).json({ error: `仅允许修改：${allowed.join('、')}` });
    const set = { updatedAt: new Date() };
    if ('name' in body) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '' || [...name].length > 50) return res.status(400).json({ error: '题库名称不能为空且不超过 50 个字符' });
      set.name = name;
    }
    if ('description' in body) set.description = typeof body.description === 'string' ? body.description.trim() : '';
    await getDb().collection('question_banks').updateOne({ _id: bank._id }, { $set: set });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// 删除题库：题库内还有题目 → 409（先删/归档题目）
router.delete('/:id', async (req, res, next) => {
  try {
    const { bank, access } = await findBankWithAccess(req.params.id, req.session.userId);
    if (!bank || access === 'none') return res.status(404).json({ error: '题库不存在或无权访问' });
    if (access !== 'owner') return res.status(403).json({ error: '仅题库所有者可删除' });
    const questionCount = await getDb().collection('questions').countDocuments({ bankId: bank._id });
    if (questionCount > 0) return res.status(409).json({ error: '题库中还有题目，不能删除（请先删除或归档题目）' });
    await getDb().collection('question_banks').deleteOne({ _id: bank._id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// 共享给其他用户（按用户名；T4 首期只读，canEdit 恒 false）
router.post('/:id/share', async (req, res, next) => {
  try {
    const { bank, access } = await findBankWithAccess(req.params.id, req.session.userId);
    if (!bank || access === 'none') return res.status(404).json({ error: '题库不存在或无权访问' });
    if (access !== 'owner') return res.status(403).json({ error: '仅题库所有者可共享' });
    const username = typeof (req.body || {}).username === 'string' ? req.body.username.trim() : '';
    if (username === '') return res.status(400).json({ error: '请输入要共享的用户名' });
    const user = await getDb().collection('users').findOne({ username });
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user._id.equals(bank.ownerId)) return res.status(400).json({ error: '不能共享给自己' });
    const exists = (bank.sharedWith || []).some((s) => s.userId.equals(user._id));
    if (exists) return res.json({ ok: true }); // 幂等
    await getDb().collection('question_banks').updateOne(
      { _id: bank._id },
      { $push: { sharedWith: { userId: user._id, canEdit: false, grantedAt: new Date() } }, $set: { updatedAt: new Date() } },
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// 取消共享（仅所有者）
router.delete('/:id/share/:userId', async (req, res, next) => {
  try {
    const { bank, access } = await findBankWithAccess(req.params.id, req.session.userId);
    if (!bank || access === 'none') return res.status(404).json({ error: '题库不存在或无权访问' });
    if (access !== 'owner') return res.status(403).json({ error: '仅题库所有者可管理共享' });
    const userId = parseId(req.params.userId);
    if (!userId) return res.status(400).json({ error: '用户 id 无效' });
    await getDb().collection('question_banks').updateOne(
      { _id: bank._id },
      { $pull: { sharedWith: { userId } }, $set: { updatedAt: new Date() } },
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// 题库内题目列表（所有者与共享用户可看）
router.get('/:id/questions', async (req, res, next) => {
  try {
    const { bank, access } = await findBankWithAccess(req.params.id, req.session.userId);
    if (!bank || access === 'none') return res.status(404).json({ error: '题库不存在或无权访问' });
    const questions = await getDb().collection('questions')
      .find({ bankId: bank._id })
      .sort({ updatedAt: -1 })
      .toArray();
    res.json(questions.map((q) => ({
      id: q._id.toHexString(),
      title: q.title,
      type: q.type,
      latestVersionNo: q.latestVersionNo,
      status: q.status,
      updatedAt: q.updatedAt,
    })));
  } catch (err) { next(err); }
});

// 新建题目（v1，仅所有者；T4 共享用户不可建版本）
router.post('/:id/questions', async (req, res, next) => {
  try {
    const { bank, access } = await findBankWithAccess(req.params.id, req.session.userId);
    if (!bank || access === 'none') return res.status(404).json({ error: '题库不存在或无权访问' });
    if (access !== 'owner') return res.status(403).json({ error: '仅题库所有者可创建题目（首期共享只读）' });
    const body = req.body || {};
    const { content, errors } = validateQuestionContent(body);
    if (errors.length) return res.status(400).json({ error: errors.map((e) => e.message).join('；') });
    const questionId = await insertQuestionAndV1({
      bank,
      content,
      changeNote: body.changeNote,
      caliberLabel: body.caliberLabel,
      createdBy: req.session.userId,
    });
    res.status(201).json({ id: questionId.toHexString(), versionNo: 1 });
  } catch (err) { next(err); }
});

// 从问卷存入题库（v1）：剥离问卷局部结构（_id / jumps），选项 id 原样保留
router.post('/:id/questions/from-survey', async (req, res, next) => {
  try {
    const { bank, access } = await findBankWithAccess(req.params.id, req.session.userId);
    if (!bank || access === 'none') return res.status(404).json({ error: '题库不存在或无权访问' });
    if (access !== 'owner') return res.status(403).json({ error: '仅题库所有者可存入题目' });
    const body = req.body || {};
    const survey = await getDb().collection('surveys').findOne({
      _id: parseId(body.surveyId),
      ownerId: new ObjectId(req.session.userId),
    });
    if (!survey) return res.status(404).json({ error: '问卷不存在或无权访问' });
    const q = survey.questions.find((x) => x._id.toHexString() === String(body.questionId));
    if (!q) return res.status(404).json({ error: '题目不存在' });
    const content = contentFromSurveyQuestion(q);
    const structureErrors = validateSurveyStructure({ questions: [{ _id: new ObjectId(), ...content, jumps: [] }] });
    if (structureErrors.length) return res.status(400).json({ error: structureErrors.map((e) => e.message).join('；') });
    const questionId = await insertQuestionAndV1({
      bank,
      content,
      changeNote: body.changeNote || '从问卷存入',
      caliberLabel: body.caliberLabel,
      createdBy: req.session.userId,
    });
    res.status(201).json({ id: questionId.toHexString(), versionNo: 1 });
  } catch (err) { next(err); }
});

module.exports = router;
