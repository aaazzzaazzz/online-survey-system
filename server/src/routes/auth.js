// 注册 / 登录 / 登出 / 当前用户
const express = require('express');
const auth = require('../auth');

const router = express.Router();

router.post('/register', async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await auth.register(body.username, body.password);
    if (!result.ok) return res.status(result.status).json({ error: result.errors.join('；') });
    res.status(201).json(result.user);
  } catch (err) { next(err); }
});

router.post('/login', async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await auth.login(body.username, body.password);
    if (!result.ok) return res.status(result.status).json({ error: result.errors.join('；') });
    req.session.userId = result.user.id;
    req.session.username = result.user.username;
    res.json(result.user);
  } catch (err) { next(err); }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  res.json({ id: req.session.userId, username: req.session.username });
});

module.exports = router;
