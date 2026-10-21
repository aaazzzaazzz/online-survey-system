// MongoDB 连接与索引。索引与 docs/database.md §8 保持一致，集中在此创建。
const { MongoClient } = require('mongodb');
const config = require('./config');

let client = null;
let db = null;

async function connect() {
  client = new MongoClient(config.mongoUri);
  await client.connect();
  db = client.db(config.dbName);
  await ensureIndexes(db);
  return db;
}

async function ensureIndexes(db) {
  await db.collection('users').createIndex({ username: 1 }, { unique: true });
  await db.collection('surveys').createIndex({ ownerId: 1, updatedAt: -1 });
  await db.collection('responses').createIndex({ surveyId: 1, submittedAt: 1 });
  await db.collection('responses').createIndex({ surveyId: 1, respondentId: 1 });
  // B1 修复：不允许重复填写的答卷由数据库层兜底（partial unique index）。
  // 条件跨文档（allowRepeat 在 surveys），因此答卷冗余 repeatAllowed 供此索引表达；
  // 匿名答卷（respondentId 为 null）与允许重复的答卷不受该约束。
  await db.collection('responses').createIndex(
    { surveyId: 1, respondentId: 1 },
    {
      name: 'unique_respondent_per_survey_when_no_repeat',
      unique: true,
      partialFilterExpression: { respondentId: { $type: 'objectId' }, repeatAllowed: false },
    },
  );
}

function getDb() {
  if (!db) throw new Error('数据库未连接：请先调用 connect()');
  return db;
}

function getClient() {
  if (!client) throw new Error('数据库未连接：请先调用 connect()');
  return client;
}

async function close() {
  if (client) await client.close();
  client = null;
  db = null;
}

module.exports = { connect, getDb, getClient, close };
