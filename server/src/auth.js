// 认证：注册 / 登录与鉴权中间件。密码只存 bcrypt 哈希，绝不存明文。
const bcrypt = require('bcryptjs');
const { getDb } = require('./db');

const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
const PASSWORD_MIN = 6;

// Q9（已确认）：用户名 3–20 字符（按 Unicode 码点计）、不含空白；密码至少 6 位
function validateCredentials(username, password) {
  const errors = [];
  const name = typeof username === 'string' ? username.trim() : '';
  if ([...name].length < USERNAME_MIN || [...name].length > USERNAME_MAX) {
    errors.push(`用户名长度需为 ${USERNAME_MIN}–${USERNAME_MAX} 个字符`);
  }
  if (/\s/.test(name)) errors.push('用户名不能包含空白字符');
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    errors.push(`密码至少 ${PASSWORD_MIN} 位`);
  }
  return { name, errors };
}

async function register(username, password) {
  const { name, errors } = validateCredentials(username, password);
  if (errors.length) return { ok: false, status: 400, errors };
  const hash = await bcrypt.hash(password, 10);
  try {
    const result = await getDb().collection('users').insertOne({
      username: name,
      passwordHash: hash,
      createdAt: new Date(),
    });
    return { ok: true, user: { id: result.insertedId.toHexString(), username: name } };
  } catch (err) {
    if (err && err.code === 11000) return { ok: false, status: 409, errors: ['用户名已被占用'] };
    throw err;
  }
}

async function login(username, password) {
  const name = typeof username === 'string' ? username.trim() : '';
  const user = await getDb().collection('users').findOne({ username: name });
  const ok = user && (await bcrypt.compare(String(password ?? ''), user.passwordHash));
  if (!ok) return { ok: false, status: 401, errors: ['用户名或密码错误'] };
  return { ok: true, user: { id: user._id.toHexString(), username: user.username } };
}

// 填写一律需要登录（Q1 已确认），所有业务接口共用此中间件
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  next();
}

module.exports = { register, login, requireAuth, validateCredentials };
