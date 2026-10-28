// 题库功能回滚脚本：删除 question_banks / questions / question_versions 三个集合。
// - 不触碰 users / surveys / responses，不修改任何现有问卷与答卷；
// - surveys.questions 上的来源字段（sourceQuestionId/sourceVersionNo/sourceCaliberKey/addedAt）
//   是惰性数据，旧代码会忽略，无需清除；
// - 题库题目被问卷引用时（surveys.questions.sourceQuestionId 存在），脚本会警告但仍按确认执行——
//   删除后问卷快照自包含，填写与统计不受影响（使用关系与跨问卷统计入口随之失效）。
// 用法：node scripts/rollback-question-bank.js [--yes]
const { MongoClient } = require('mongodb');
const config = require('../server/src/config');

const COLLECTIONS = ['question_banks', 'questions', 'question_versions'];
const confirmed = process.argv.includes('--yes');

async function main() {
  const client = new MongoClient(config.mongoUri);
  await client.connect();
  const db = client.db(config.dbName);
  console.log(`数据库：${config.dbName}`);
  for (const name of COLLECTIONS) {
    const count = await db.collection(name).countDocuments();
    console.log(`  集合 ${name}: ${count} 个文档`);
  }
  const usage = await db.collection('surveys').countDocuments({ 'questions.sourceQuestionId': { $exists: true } });
  if (usage > 0) {
    console.log(`警告：有 ${usage} 份问卷中的题目带有题库来源字段。删除集合后这些问卷的快照仍自包含，`);
    console.log('      填写/提交/统计不受影响；但使用关系与跨问卷统计功能不可再用。');
  }
  if (!confirmed) {
    console.log('未删除任何数据。确认回滚请加 --yes 参数。');
    await client.close();
    process.exit(0);
  }
  for (const name of COLLECTIONS) {
    await db.collection(name).drop().catch((err) => {
      if (err.codeName !== 'NamespaceNotFound') throw err;
    });
    console.log(`  已删除 ${name}`);
  }
  console.log('回滚完成。现有 users / surveys / responses 未被修改。');
  await client.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
