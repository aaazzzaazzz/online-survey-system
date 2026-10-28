// 题目版本测试：v1 结构与默认口径、基于指定版本建新版本（parent 正确）、选项 id 跨版本稳定、
// 恢复 = 新建记录且链路完整、版本不可覆盖（无更新路由）、并发版本号互异（$inc + 唯一索引）、
// clientToken 幂等重试、版本号空缺容忍、latestVersionNo 自愈（V1）、权限（T4：共享用户不可建版本）。
process.env.MONGODB_DB = 'survey_system_test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoClient, ObjectId } = require('mongodb');
const h = require('./helpers');

let ctx;
let cookie, viewerCookie;

before(async () => {
  await h.resetTestDb();
  ctx = await h.startServer();
  cookie = await h.registerAndLogin(ctx.base, 'vowner');
  viewerCookie = await h.registerAndLogin(ctx.base, 'vviewer');
});
after(async () => {
  await h.stopServer(ctx);
  if (directClient) await directClient.close();
});

// 直连客户端复用并随测试结束关闭（否则 node:test 进程不退出）
let directClient = null;
async function directDb() {
  if (!directClient) {
    directClient = new MongoClient('mongodb://127.0.0.1:27017');
    await directClient.connect();
  }
  return directClient.db('survey_system_test');
}

let bankId;
let questionId;

async function createBank(name = '版本题库') {
  const r = await h.req(ctx.base, '/api/banks', { method: 'POST', cookie, body: { name } });
  assert.equal(r.status, 201);
  return r.data.id;
}

async function createQuestion(body = { type: 'single', title: '颜色', required: true, options: ['红', '蓝'] }, targetBankId = bankId) {
  const r = await h.req(ctx.base, `/api/banks/${targetBankId}/questions`, { method: 'POST', cookie, body });
  assert.equal(r.status, 201);
  return r.data.id;
}

async function newVersion(qid, body, extra = {}) {
  return h.req(ctx.base, `/api/questions/${qid}/versions`, { method: 'POST', cookie, body: { ...body, ...extra } });
}

async function getVersion(qid, vNo) {
  const r = await h.req(ctx.base, `/api/questions/${qid}/versions/${vNo}`, { cookie });
  assert.equal(r.status, 200);
  return r.data;
}

test('v1：版本号 1、无父版本、默认口径', async () => {
  bankId = await createBank();
  questionId = await createQuestion({ type: 'single', title: '颜色', required: true, options: ['红', '蓝'], changeNote: '初版' });
  const v1 = await getVersion(questionId, 1);
  assert.equal(v1.parentVersionNo, null);
  assert.equal(v1.statsCaliber.caliberLabel, '默认口径');
  assert.deepEqual(v1.content.options.map((o) => o.label), ['红', '蓝']);
});

test('新版本：版本号递增、parent 指向基础版本、口径继承', async () => {
  const v1 = await getVersion(questionId, 1);
  const r = await newVersion(questionId, { type: 'single', title: '颜色（改）', required: true, options: ['红', '蓝'] });
  assert.equal(r.status, 201);
  assert.equal(r.data.versionNo, 2);
  const v2 = await getVersion(questionId, 2);
  assert.equal(v2.parentVersionNo, 1);
  assert.equal(v2.statsCaliber.caliberKey, v1.statsCaliber.caliberKey, '未声明口径变更时应继承');
  assert.equal(v2.content.title, '颜色（改）');
});

test('基于旧版本建新版本：baseVersionNo=1 时 parent=1（分支演化）', async () => {
  const r = await newVersion(questionId, { type: 'single', title: '颜色（基于v1）', required: true, options: ['红', '蓝'] }, { baseVersionNo: 1 });
  assert.equal(r.status, 201);
  assert.equal(r.data.versionNo, 3);
  const v3 = await getVersion(questionId, 3);
  assert.equal(v3.parentVersionNo, 1, '基于 v1 创建时 parent 应为 1');
});

test('选项 id 跨版本稳定：回传旧 id 复用，新增选项生成新 id', async () => {
  const v1 = await getVersion(questionId, 1);
  const redId = v1.content.options.find((o) => o.label === '红')._id; // HTTP 响应中已是 hex 字符串
  const r = await newVersion(questionId, {
    type: 'single', title: '颜色', required: true,
    options: [{ id: redId, label: '红' }, { label: '绿' }],
  }, { baseVersionNo: 1 });
  assert.equal(r.status, 201);
  const v4 = await getVersion(questionId, r.data.versionNo);
  assert.equal(v4.content.options.find((o) => o.label === '红')._id, redId, '旧选项 id 应复用');
  assert.notEqual(v4.content.options.find((o) => o.label === '绿')._id, redId, '新选项应有新 id');
});

test('恢复历史版本 = 新建记录：parent=被恢复版本、内容一致、口径继承被恢复版本', async () => {
  const v1 = await getVersion(questionId, 1);
  const r = await h.req(ctx.base, `/api/questions/${questionId}/versions/1/restore`, {
    method: 'POST', cookie, body: {},
  });
  assert.equal(r.status, 201);
  const vN = await getVersion(questionId, r.data.versionNo);
  assert.equal(vN.parentVersionNo, 1);
  assert.deepEqual(vN.content, v1.content, '恢复内容应与 v1 一致');
  assert.equal(vN.changeNote, '恢复自 v1');
  // v1 本身不可变
  const v1After = await getVersion(questionId, 1);
  assert.deepEqual(v1After.content, v1.content, '历史版本不得被覆盖');
});

test('版本不可覆盖：版本无更新/删除路由（404）', async () => {
  for (const [method, path] of [['PUT', `/api/questions/${questionId}/versions/1`], ['PATCH', `/api/questions/${questionId}/versions/1`], ['DELETE', `/api/questions/${questionId}/versions/1`]]) {
    const r = await h.req(ctx.base, path, { method, cookie, body: { title: 'x' } });
    assert.equal(r.status, 404, `${method} 版本端点应不存在`);
  }
});

test('并发建版本：5 个并发请求得到互不相同的版本号且全部落库', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    newVersion(questionId, { type: 'single', title: `并发 ${i}`, required: true, options: ['红', '蓝'] })));
  for (const r of results) assert.equal(r.status, 201, `并发请求应成功: ${JSON.stringify(r.data)}`);
  const numbers = results.map((r) => r.data.versionNo);
  assert.equal(new Set(numbers).size, 5, '版本号应互不相同');
  const list = await h.req(ctx.base, `/api/questions/${questionId}/versions`, { cookie });
  for (const n of numbers) assert.ok(list.data.some((v) => v.versionNo === n), `版本 ${n} 应存在`);
});

test('clientToken 幂等：同 token 重试两次只建一个版本，第二次返回同一版本号（V2）', async () => {
  const token = 'retry-token-' + Date.now();
  const body = { type: 'single', title: '幂等题', required: true, options: ['红', '蓝'], clientToken: token };
  const r1 = await newVersion(questionId, body);
  const r2 = await newVersion(questionId, body);
  assert.equal(r1.status, 201);
  assert.equal(r1.data.idempotent, false);
  assert.equal(r2.status, 200);
  assert.equal(r2.data.idempotent, true);
  assert.equal(r1.data.versionNo, r2.data.versionNo, '重试应返回同一版本号');
  const db = await directDb();
  const count = await db.collection('question_versions').countDocuments({ questionId: new ObjectId(questionId), clientToken: token });
  assert.equal(count, 1, '同 token 只能存在一个版本文档');
});

test('版本号空缺容忍：缺失中间版本时列表/详情/自愈正常', async () => {
  const db = await directDb();
  // 人为构造空缺：删除中间版本（系统正常运行不会出现；此处验证容忍性）
  const versions = db.collection('question_versions');
  const mids = await versions.find({ questionId: { $exists: true } }).sort({ versionNo: 1 }).toArray();
  const qid = mids[0].questionId;
  const before = await versions.countDocuments({ questionId: qid });
  assert.ok(before >= 3, '应有足够版本构造空缺');
  await versions.deleteMany({ questionId: qid, versionNo: 2 });
  await db.collection('questions').updateOne({ _id: qid }, { $set: { latestVersionNo: 1 } }); // 人为制造 latestVersionNo 落后（V1 场景）
  const detail = await h.req(ctx.base, `/api/questions/${qid.toHexString()}`, { cookie });
  const list = await h.req(ctx.base, `/api/questions/${qid.toHexString()}/versions`, { cookie });
  assert.ok(!list.data.some((v) => v.versionNo === 2), '被删除的版本不应出现');
  assert.ok(list.data.length > 0, '其余版本仍可查');
  assert.ok(detail.data.latestVersionNo >= list.data.at(-1).versionNo, '详情读取应自愈 latestVersionNo');
  assert.ok(!list.data.some((v) => v.versionNo === detail.data.latestVersionNo) === false, 'latestVersionNo 应指向实际存在的版本');
});

test('latestVersionNo 自愈：人为落后时读取详情后收敛（V1）', async () => {
  const db = await directDb();
  const qid = await db.collection('questions').findOne({});
  const max = await db.collection('question_versions').find({ questionId: qid._id }).sort({ versionNo: -1 }).limit(1).next();
  await db.collection('questions').updateOne({ _id: qid._id }, { $set: { latestVersionNo: 1 } });
  const detail = await h.req(ctx.base, `/api/questions/${qid._id.toHexString()}`, { cookie });
  assert.equal(detail.data.latestVersionNo, max.versionNo, '读取详情后 latestVersionNo 应指向实际最高版本');
});

test('校验：选项不足/未知基础版本/非法 clientToken 拒绝', async () => {
  const bad = await newVersion(questionId, { type: 'single', title: 'x', required: true, options: ['仅一个'] });
  assert.equal(bad.status, 400);
  const badBase = await newVersion(questionId, { type: 'single', title: 'x', required: true, options: ['红', '蓝'] }, { baseVersionNo: 999 });
  assert.equal(badBase.status, 404);
  const badToken = await newVersion(questionId, { type: 'single', title: 'x', required: true, options: ['红', '蓝'] }, { clientToken: 'a'.repeat(65) });
  assert.equal(badToken.status, 400);
  const restoreMissing = await h.req(ctx.base, `/api/questions/${questionId}/versions/999/restore`, { method: 'POST', cookie });
  assert.equal(restoreMissing.status, 404);
});

test('权限（T4）：共享用户可查看题目与版本，但不能建版本/恢复/归档', async () => {
  const b = await createBank('共享版本库');
  const q = await createQuestion(undefined, b);
  await h.req(ctx.base, `/api/banks/${b}/share`, { method: 'POST', cookie, body: { username: 'vviewer' } });
  const detail = await h.req(ctx.base, `/api/questions/${q}`, { cookie: viewerCookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.role, 'viewer');
  for (const [method, path, body] of [
    ['POST', `/api/questions/${q}/versions`, { type: 'single', title: 'x', required: true, options: ['红', '蓝'] }],
    ['POST', `/api/questions/${q}/versions/1/restore`, {}],
    ['POST', `/api/questions/${q}/archive`, undefined],
    ['DELETE', `/api/questions/${q}`, undefined],
  ]) {
    const r = await h.req(ctx.base, path, { method, cookie: viewerCookie, body });
    assert.equal(r.status, 403, `${method} ${path} 应对共享只读用户 403`);
  }
});

test('删除被使用的题目 → 409（T5）；未使用 → 版本级联删除', async () => {
  const b = await createBank('删除测试库');
  const q = await createQuestion();
  const survey = await h.req(ctx.base, '/api/surveys', { method: 'POST', cookie, body: { title: '使用问卷', allowAnonymous: false, allowRepeat: false } });
  const add = await h.req(ctx.base, `/api/surveys/${survey.data.id}/questions/from-bank`, { method: 'POST', cookie, body: { bankQuestionId: q } });
  assert.equal(add.status, 201);
  const blocked = await h.req(ctx.base, `/api/questions/${q}`, { method: 'DELETE', cookie });
  assert.equal(blocked.status, 409);

  const db = await directDb();
  const unusedQ = await createQuestion({ type: 'single', title: '未使用', required: true, options: ['红', '蓝'] });
  const qid = await db.collection('questions').findOne({ title: '未使用' });
  assert.ok(qid, '未使用题目应存在');
  const del = await h.req(ctx.base, `/api/questions/${unusedQ}`, { method: 'DELETE', cookie });
  assert.equal(del.status, 200);
  const versionsLeft = await db.collection('question_versions').countDocuments({ questionId: qid._id });
  assert.equal(versionsLeft, 0, '删除题目应级联删除全部版本');
  const masterLeft = await db.collection('questions').countDocuments({ _id: qid._id });
  assert.equal(masterLeft, 0, '主记录应被删除');
});
