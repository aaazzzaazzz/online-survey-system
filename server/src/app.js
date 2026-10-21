// 应用组装：会话（存 MongoDB）、API 路由、静态前端、统一错误处理。
const path = require('path');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const config = require('./config');
const { connect, getClient, close } = require('./db');

const app = express();
app.use(express.json());

// connect-mongo 在数据库连接就绪后使用该 client（由 start() 触发）
let clientReady;
const clientPromise = new Promise((resolve) => { clientReady = resolve; });

app.use(session({
  name: 'survey.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ clientPromise, dbName: config.dbName, ttl: 7 * 24 * 3600 }),
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 },
}));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/surveys', require('./routes/surveys'));
app.use('/api/fill', require('./routes/fill'));
app.use('/api/stats', require('./routes/stats'));

// 静态前端
app.use(express.static(path.join(__dirname, '..', '..', 'public')));
app.get('/survey/:id', (req, res) => res.sendFile(path.join(__dirname, '..', '..', 'public', 'fill.html')));
app.get('/', (req, res) => res.redirect('/login.html'));

// 统一错误处理：不向客户端泄露内部细节
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: '请求体不是合法 JSON' });
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

// 启动：连接数据库后监听端口（测试用 start(0) 取随机端口）
async function start(port = config.port) {
  await connect();
  clientReady(getClient());
  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve({ server, port: server.address().port }));
  });
}

if (require.main === module) {
  start().then(({ port }) => console.log(`问卷系统已启动: http://localhost:${port}（数据库: ${config.dbName}）`));
}

module.exports = { app, start, close };
