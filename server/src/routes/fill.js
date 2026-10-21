// 填写端：填写页数据与提交。填写一律需要登录（Q1 已确认）。
const express = require('express');
const { ObjectId } = require('mongodb');
const { getDb } = require('../db');
const { requireAuth } = require('../auth');
const { submitResponse } = require('../services/submit');
const { openness } = require('../services/lifecycle');

const router = express.Router();
router.use(requireAuth);

function parseId(id) {
  try { return new ObjectId(id); } catch { return null; }
}

// 填写页数据（仅开放中的问卷：已发布、未手动关闭、未过截止时间）
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const survey = id && await getDb().collection('surveys').findOne({ _id: id });
    if (!survey) return res.status(404).json({ error: '问卷不存在' });
    const state = openness(survey);
    if (!state.open) return res.status(403).json({ error: state.reason });
    res.json({
      id: survey._id.toHexString(),
      title: survey.title,
      description: survey.description,
      allowAnonymous: survey.allowAnonymous,
      allowRepeat: survey.allowRepeat,
      deadline: survey.deadline,
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
        // 跳转规则（供填写页即时计算下一题；服务端提交时仍重新计算，不信任前端）
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
    });
  } catch (err) { next(err); }
});

// 提交答卷
router.post('/:id/submit', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const survey = id && await getDb().collection('surveys').findOne({ _id: id });
    if (!survey) return res.status(404).json({ error: '问卷不存在' });
    const result = await submitResponse(survey, { _id: req.session.userId }, (req.body || {}).answers);
    if (!result.ok) return res.status(result.status).json({ error: result.errors.join('；') });
    res.status(201).json({ id: result.responseId });
  } catch (err) { next(err); }
});

module.exports = router;
