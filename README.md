# 在线问卷系统（MongoDB）

基于 MongoDB 的在线问卷系统：注册登录 → 创建/编辑问卷（单选、多选、文本、数字四种题型，条件跳转）→ 发布/截止/关闭/复制 → 通过分享链接填写提交 → 基于真实答卷统计。

## 功能

- **用户**：注册、登录（bcrypt 哈希存储、会话存 MongoDB）；只能管理自己的问卷与统计。
- **问卷生命周期**：创建（草稿）→ 发布 → 主动关闭（关闭后保持关闭）；截止时间（ISO 8601、服务端判断、无效/过去时间拒绝、可延期）。
- **题目管理**（草稿）：创建问卷时添加多道题目（四种题型及各自校验配置、跳转规则配置）；发布与关闭后结构锁定（服务端强制）。
- **条件跳转**：单选（选中选项）、多选（any/all，默认 any）、数字（= ≠ < ≤ > ≥ 六种运算符）；规则按顺序首条命中；只允许向后跳转；非法配置拒绝保存与发布。
- **填写**：按跳转逐步推进、可回退；服务端重新计算合法路径并最终校验全部答案；匿名（不记录身份）与重复填写（不允许时数据库层兜底并发）。
- **统计**：单选各选项人数、多选各选项选择次数、文本内容、数字平均值、该题回答人数、总答卷数——全部由真实答卷聚合，无写死数据。
- **题库与题目复用**：题库创建/管理/按用户名共享（题库级与单题级两种粒度，均为只读复用）；题目版本化（不可变版本链、基于任意版本新建、恢复 = 新建记录、并发安全的原子版本号、幂等重试）；从题库把指定版本快照进问卷（内容固定，题库后续更新/归档/撤销共享不影响问卷；跳转在问卷内重新配置）；存入题库；归档与"显示已归档"恢复入口。
- **使用关系与跨问卷统计**：按逻辑题目查被哪些问卷使用（他人问卷标题隐藏）；跨问卷统计按"口径声明 + 内容签名"双重判定合并（仅聚合本人问卷），支持单版本查询与数字加权均值。

## 技术栈

Node.js ≥ 24 + Express 5 + 官方 `mongodb` 驱动；静态 HTML/CSS/JS 前端（无构建）；`express-session` + `connect-mongo`（会话存 MongoDB）；`bcryptjs` 密码哈希；Node 内置 `node:test` 测试（真实本地 MongoDB 测试库）。

## 快速开始

```bash
# 1. 启动本项目专用 MongoDB（数据目录 D:\MongoDB\survey-data，不动其他数据目录）
scripts\start-mongo.bat
# 等价：mongod --dbpath "D:\MongoDB\survey-data" --port 27017 --bind_ip 127.0.0.1 --logpath "D:\MongoDB\survey-data\mongod.log" --logappend（用自己的路径）

# 2. 启动后端（首次先安装依赖）
cd server
npm install
npm start          # http://localhost:3000

# 3. 浏览器验收步骤见 docs/runbook.md
```

## 运行测试

```bash
cd server
npm test           # 需本地 MongoDB 运行中；使用独立测试库 survey_system_test（每次运行前自动清空）
```

## 环境变量（可选）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | 3000 | 服务端口 |
| `MONGODB_URI` | mongodb://127.0.0.1:27017 | MongoDB 连接串 |
| `MONGODB_DB` | survey_system | 数据库名（测试库 survey_system_test） |
| `SESSION_SECRET` | dev-only-secret | 会话签名密钥，**部署时必须改为随机值** |

## 文档

| 文档 | 内容 |
| --- | --- |
| `CLAUDE.md` | 长期技术约束与协作规则 |
| `docs/requirements.md` | 需求、业务规则（Q1–Q9 已确认）、实现进度 |
| `docs/database.md` | MongoDB 集合/字段/索引、嵌入与引用理由、生命周期语义 |
| `docs/api.md` | 全部 HTTP 接口说明 |
| `docs/runbook.md` | 本地启动与浏览器验收步骤（含题库功能验收） |
| `docs/testing.md` | 测试清单、运行方式与实际证据位置 |
| `docs/ai-log.md` | 每轮真实开发记录（含失败与修复） |
| `scripts/rollback-question-bank.js` | 题库功能回滚脚本（`node scripts/rollback-question-bank.js --yes`） |


