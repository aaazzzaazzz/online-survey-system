// 统计：仅问卷所有者可查看（需求 1.1），基于真实答卷计算。
const express = require('express');
const { ObjectId } = require('mongodb');
const { getDb } = require('../db');
const { requireAuth } = require('../auth');
const { computeStats } = require('../services/stats');

const router = express.Router();
router.use(requireAuth);

router.get('/:id', async (req, res, next) => {
  try {
    let id;
    try { id = new ObjectId(req.params.id); } catch { return res.status(404).json({ error: '问卷不存在或无权访问' }); }
    const survey = await getDb().collection('surveys').findOne({ _id: id, ownerId: new ObjectId(req.session.userId) });
    if (!survey) return res.status(404).json({ error: '问卷不存在或无权访问' });
    res.json(await computeStats(survey));
  } catch (err) { next(err); }
});

module.exports = router;
