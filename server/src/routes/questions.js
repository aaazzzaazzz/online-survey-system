// 题目与版本：详情（latestVersionNo 自愈）、版本列表/详情、新版本（幂等 clientToken）、
// 恢复历史版本（新建记录）、归档/取消归档、删除（被使用 409，T5）、使用关系、跨问卷统计、
// 单题共享（第 20 轮新增：题库授权或单题授权任一即可只读访问/复用）。
const express = require('express');
const { getDb } = require('../db');
const { requireAuth } = require('../auth');
const { getBankAccess } = require('../services/bank-access');
const {
  createVersion,
  restoreVersion,
  deleteQuestion,
  listUsages,
  healLatestVersion,
} = require('../services/question-versions');
const { computeCrossStats } = require('../services/question-stats');

const router = express.Router();
router.use(requireAuth);

function parseId(id) { try { return new (require('mongodb').ObjectId)(id); } catch { return null; } }

// 权限：题库授权（owner/viewer）优先；题库无授权时检查单题授权（viewer）
async function findQuestionWithAccess(idParam, userId) {
  const id = parseId(idParam);
  if (!id) return { question: null, access: 'none' };
  const question = await getDb().collection('questions').findOne({ _id: id });
  if (!question) return { question: null, access: 'none' };
  const bank = await getDb().collection('question_banks').findOne({ _id: question.bankId });
  const access = getBankAccess(bank, userId);
  if (access !== 'none') return { question, bank, access };
  const sharedToMe = (question.sharedWith || []).some((s) => s.userId.toHexString() === String(userId));
  return { question, bank, access: sharedToMe ? 'viewer' : 'none' };
}

// 共享给我的题目列表（第 20 轮：单题共享入口；必须放在 /:id 之前，避免 shared 被当作题目 id）
router.get('/shared', async (req, res, next) => {
  try {
    const uid = new (require('mongodb').ObjectId)(req.session.userId);
    const questions = await getDb().collection('questions')
      .find({ 'sharedWith.userId': uid })
      .sort({ updatedAt: -1 })
      .toArray();
    const banks = await getDb().collection('question_banks')
      .find({ _id: { $in: questions.map((q) => q.bankId) } }, { projection: { name: 1 } })
      .toArray();
    const bankNameById = new Map(banks.map((b) => [b._id.toHexString(), b.name]));
    res.json(questions.map((q) => {
      const grant = (q.sharedWith || []).find((s) => s.userId.toHexString() === req.session.userId);
      return {
        id: q._id.toHexString(),
        title: q.title,
        type: q.type,
        latestVersionNo: q.latestVersionNo,
        status: q.status,
        bankName: bankNameById.get(q.bankId.toHexString()) || null,
        grantedAt: grant ? grant.grantedAt : null,
      };
    }));
  } catch (err) { next(err); }
});

// 单题共享给其他用户（按用户名，只读复用；仅题目所有者可管理）
router.post('/:id/share', async (req, res, next) => {
  try {
    const { question, access } = await findQuestionWithAccess(req.params.id, req.session.userId);
    if (!question || access === 'none') return res.status(404).json({ error: '题目不存在或无权访问' });
    if (access !== 'owner') return res.status(403).json({ error: '仅题目所有者可管理共享' });
    const username = typeof (req.body || {}).username === 'string' ? req.body.username.trim() : '';
    if (username === '') return res.status(400).json({ error: '请输入要共享的用户名' });
    const user = await getDb().collection('users').findOne({ username });
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user._id.toHexString() === String(req.session.userId)) return res.status(400).json({ error: '不能共享给自己' });
    const exists = (question.sharedWith || []).some((s) => s.userId.equals(user._id));
    if (exists) return res.json({ ok: true }); // 幂等
    await getDb().collection('questions').updateOne(
      { _id: question._id },
      { $push: { sharedWith: { userId: user._id, grantedAt: new Date() } }, $set: { updatedAt: new Date() } },
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// 取消单题共享（仅题目所有者）
router.delete('/:id/share/:userId', async (req, res, next) => {
  try {
    const { question, access } = await findQuestionWithAccess(req.params.id, req.session.userId);
    if (!question || access === 'none') return res.status(404).json({ error: '题目不存在或无权访问' });
    if (access !== 'owner') return res.status(403).json({ error: '仅题目所有者可管理共享' });
    const userId = parseId(req.params.userId);
    if (!userId) return res.status(400).json({ error: '用户 id 无效' });
    await getDb().collection('questions').updateOne(
      { _id: question._id },
      { $pull: { sharedWith: { userId } }, $set: { updatedAt: new Date() } },
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// 题目详情：最新版本内容 + 当前用户角色；读取时自愈 latestVersionNo
router.get('/:id', async (req, res, next) => {
  try {
    const { question, access } = await findQuestionWithAccess(req.params.id, req.session.userId);
    if (!question || access === 'none') return res.status(404).json({ error: '题目不存在或无权访问' });
    await healLatestVersion(question);
    const latest = await getDb().collection('question_versions').findOne(
      { questionId: question._id, versionNo: question.latestVersionNo },
    );
    // 单题共享列表（含用户名）仅题目所有者可见（第 20 轮）
    let sharedWith = undefined;
    if (access === 'owner') {
      const ids = (question.sharedWith || []).map((s) => s.userId);
      const users = ids.length
        ? await getDb().collection('users').find({ _id: { $in: ids } }, { projection: { username: 1 } }).toArray()
        : [];
      const nameById = new Map(users.map((u) => [u._id.toHexString(), u.username]));
      sharedWith = (question.sharedWith || []).map((s) => ({
        userId: s.userId.toHexString(),
        username: nameById.get(s.userId.toHexString()) || null,
        grantedAt: s.grantedAt,
      }));
    }
    res.json({
      id: question._id.toHexString(),
      bankId: question.bankId.toHexString(),
      title: question.title,
      type: question.type,
      latestVersionNo: question.latestVersionNo,
      status: question.status,
      role: access,
      sharedWith,
      createdAt: question.createdAt,
      updatedAt: question.updatedAt,
      latest: latest ? {
        versionNo: latest.versionNo,
        parentVersionNo: latest.parentVersionNo,
        content: latest.content,
        statsCaliber: latest.statsCaliber,
        changeNote: latest.changeNote,
        createdAt: latest.createdAt,
      } : null,
    });
  } catch (err) { next(err); }
});

// 版本列表（升序，含父子关系与口径）
router.get('/:id/versions', async (req, res, next) => {
  try {
    const { question, access } = await findQuestionWithAccess(req.params.id, req.session.userId);
    if (!question || access === 'none') return res.status(404).json({ error: '题目不存在或无权访问' });
    const versions = await getDb().collection('question_versions')
      .find({ questionId: question._id })
      .sort({ versionNo: 1 })
      .toArray();
    res.json(versions.map((v) => ({
      versionNo: v.versionNo,
      parentVersionNo: v.parentVersionNo,
      caliberLabel: v.statsCaliber ? v.statsCaliber.caliberLabel : null,
      changeNote: v.changeNote,
      createdAt: v.createdAt,
    })));
  } catch (err) { next(err); }
});

// 单个版本完整内容
router.get('/:id/versions/:vNo', async (req, res, next) => {
  try {
    const { question, access } = await findQuestionWithAccess(req.params.id, req.session.userId);
    if (!question || access === 'none') return res.status(404).json({ error: '题目不存在或无权访问' });
    const version = await getDb().collection('question_versions').findOne(
      { questionId: question._id, versionNo: Number(req.params.vNo) },
    );
    if (!version) return res.status(404).json({ error: '版本不存在' });
    res.json({
      versionNo: version.versionNo,
      parentVersionNo: version.parentVersionNo,
      content: version.content,
      statsCaliber: version.statsCaliber,
      changeNote: version.changeNote,
      createdAt: version.createdAt,
    });
  } catch (err) { next(err); }
});

// 基于已有版本创建新版本（baseVersionNo 缺省 = 最新版本；口径默认继承，可声明变更）
router.post('/:id/versions', async (req, res, next) => {
  try {
    const { question, access } = await findQuestionWithAccess(req.params.id, req.session.userId);
    if (!question || access === 'none') return res.status(404).json({ error: '题目不存在或无权访问' });
    if (access !== 'owner') return res.status(403).json({ error: '仅题库所有者可创建版本（首期共享只读）' });
    const body = req.body || {};
    const result = await createVersion(question, {
      baseVersionNo: body.baseVersionNo,
      body,
      changeNote: body.changeNote,
      caliberChanged: body.caliberChanged,
      caliberLabel: body.caliberLabel,
      clientToken: body.clientToken,
    }, req.session.userId);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.status(result.idempotent ? 200 : 201).json({ versionNo: result.versionNo, idempotent: result.idempotent });
  } catch (err) { next(err); }
});

// 恢复历史版本 = 新建版本记录（parent = 被恢复版本，口径继承它）
router.post('/:id/versions/:vNo/restore', async (req, res, next) => {
  try {
    const { question, access } = await findQuestionWithAccess(req.params.id, req.session.userId);
    if (!question || access === 'none') return res.status(404).json({ error: '题目不存在或无权访问' });
    if (access !== 'owner') return res.status(403).json({ error: '仅题库所有者可恢复版本' });
    const result = await restoreVersion(question, Number(req.params.vNo), {
      changeNote: (req.body || {}).changeNote,
      clientToken: (req.body || {}).clientToken,
    }, req.session.userId);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.status(result.idempotent ? 200 : 201).json({ versionNo: result.versionNo, idempotent: result.idempotent });
  } catch (err) { next(err); }
});

// 归档（日常操作首选）：从默认列表与"从题库添加"选择器隐藏；不影响已使用问卷
router.post('/:id/archive', async (req, res, next) => {
  try {
    const { question, access } = await findQuestionWithAccess(req.params.id, req.session.userId);
    if (!question || access === 'none') return res.status(404).json({ error: '题目不存在或无权访问' });
    if (access !== 'owner') return res.status(403).json({ error: '仅题库所有者可归档' });
    await getDb().collection('questions').updateOne(
      { _id: question._id },
      { $set: { status: 'archived', updatedAt: new Date() } },
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:id/unarchive', async (req, res, next) => {
  try {
    const { question, access } = await findQuestionWithAccess(req.params.id, req.session.userId);
    if (!question || access === 'none') return res.status(404).json({ error: '题目不存在或无权访问' });
    if (access !== 'owner') return res.status(403).json({ error: '仅题库所有者可取消归档' });
    await getDb().collection('questions').updateOne(
      { _id: question._id },
      { $set: { status: 'active', updatedAt: new Date() } },
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// 删除题目：被任一问卷使用 → 409（T5）；未使用 → 版本级联删除
router.delete('/:id', async (req, res, next) => {
  try {
    const { question, access } = await findQuestionWithAccess(req.params.id, req.session.userId);
    if (!question || access === 'none') return res.status(404).json({ error: '题目不存在或无权访问' });
    if (access !== 'owner') return res.status(403).json({ error: '仅题库所有者可删除' });
    const result = await deleteQuestion(question);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// 使用关系（派生查询）：他人问卷标题隐藏（T2），仅返回状态/版本/时间
router.get('/:id/usages', async (req, res, next) => {
  try {
    const { question, access } = await findQuestionWithAccess(req.params.id, req.session.userId);
    if (!question || access === 'none') return res.status(404).json({ error: '题目不存在或无权访问' });
    res.json(await listUsages(question, req.session.userId));
  } catch (err) { next(err); }
});

// 跨问卷统计（T1：仅聚合请求者本人问卷；支持 ?versionNo= 单版本查询）
router.get('/:id/cross-stats', async (req, res, next) => {
  try {
    const { question, access } = await findQuestionWithAccess(req.params.id, req.session.userId);
    if (!question || access === 'none') return res.status(404).json({ error: '题目不存在或无权访问' });
    const versionNo = req.query.versionNo === undefined ? undefined : Number(req.query.versionNo);
    res.json(await computeCrossStats(question, req.session.userId, { versionNo }));
  } catch (err) { next(err); }
});

module.exports = router;
