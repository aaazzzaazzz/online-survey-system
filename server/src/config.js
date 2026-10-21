// 集中配置：端口 / MongoDB / 会话密钥，均可由环境变量覆盖。
// 默认值仅供本地开发；SESSION_SECRET 部署时应通过环境变量设置。
module.exports = {
  port: Number(process.env.PORT || 3000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  dbName: process.env.MONGODB_DB || 'survey_system',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-secret',
};
