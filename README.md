# 在线问卷系统

> 本文档按课程要求的文档四要素完整撰写：**系统说明、数据库设计、API 说明、关键逻辑说明**（见下方「文档」部分，各小节末尾附详细文档链接）。

基于 MongoDB 的在线问卷系统：注册登录 → 创建问卷（单选、多选、文本、数字四种题型，条件跳转）→ 发布/截止/关闭 → 通过分享链接填写提交 → 基于真实答卷统计；并提供题库管理、题目复用与版本管理、题库/单题共享、使用关系查询与跨问卷统计。

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

### 1. 系统说明

**项目定位**：简化版在线问卷系统（类似问卷星 / Google Forms）。注册用户创建问卷、通过分享链接收集答卷、查看真实统计；并可用题库沉淀与复用题目。所有业务数据持久化于 MongoDB，不使用关系数据库、不使用现成问卷框架。

**技术架构**：

- 后端：Node.js ≥ 24 + Express 5 + 官方 `mongodb` 驱动（不用 ORM，文档结构与数据库一一对应）
- 认证与会话：`bcryptjs` 密码哈希（cost 10，绝不存明文）+ `express-session` + `connect-mongo`（会话存 MongoDB，服务重启不丢登录态）
- 前端：静态 HTML/CSS/JS + fetch（无构建步骤），共 6 个页面：`login.html`（登录/注册）、`surveys.html`（我的问卷）、`survey.html`（问卷编辑：题目、跳转、发布、从题库选题）、`survey/:id` 填写页、`stats.html`（问卷统计）、`banks.html`（题库管理：建库、共享、题目、版本历史、使用关系、跨问卷统计）
- 测试：Node 内置 `node:test`，跑在真实本地 MongoDB 独立测试库上（不使用 mock）

**模块划分**（代码职责清晰、局部可改）：

| 位置 | 职责 |
| --- | --- |
| `server/src/app.js` | 应用组装：会话、路由挂载、静态前端、统一错误处理 |
| `server/src/config.js` | 端口 / MongoDB 连接 / 会话密钥（环境变量可覆盖） |
| `server/src/db.js` | Mongo 连接与全部索引集中创建（幂等 createIndex） |
| `server/src/auth.js` | 注册/登录（用户名与密码规则）、鉴权中间件 |
| `server/src/validation.js` | 问卷与题目结构校验、跳转规则校验（保存/发布时执行） |
| `server/src/routes/` | auth / surveys / fill / stats / banks / questions 六个路由组 |
| `server/src/services/question-types.js` | **题型注册表**：结构校验、答案校验、值规范化、统计集中于此，新增题型只改这一处 |
| `server/src/services/validate-answers.js` | 提交时答案最终校验（按重新计算的填写路径） |
| `server/src/services/resolve-jumps.js` | 跳转路径解析（规则首条命中、只向后） |
| `server/src/services/submit.js` | 提交策略：生命周期判断 → 校验 → 重复限制 → 保存答卷 |
| `server/src/services/lifecycle.js` | 发布/关闭/截止三者分离的统一开放判断 |
| `server/src/services/stats.js` | 问卷统计（直接聚合真实答卷，无缓存） |
| `server/src/services/bank-access.js` | 题库权限判定（owner / viewer / none） |
| `server/src/services/question-versions.js` | 题目与版本核心：原子版本号、幂等重试、恢复、删除、使用关系 |
| `server/src/services/question-stats.js` | 跨问卷统计：内容签名、口径分组、加权聚合 |
| `scripts/` | `start-mongo.bat` / `stop-mongo.bat` / `rollback-question-bank.js` |

**业务链路**：

1. **问卷链路**：注册登录 → 创建问卷（标题/说明/匿名/重复开关，草稿状态一次添加多道题目：单选/多选/文本/数字 + 各题型校验配置 + 条件跳转规则）→ 发布（发布后题目结构锁定）→ 设置截止时间 / 主动关闭 → 分享链接（`/survey/:id`）→ 填写者登录后按顺序作答、按规则跳转、提交（服务端最终校验）→ 所有者查看基于真实答卷的统计。
2. **题库链路**：建库（名称+说明）→ 存题（题库内新建，或把问卷里的题"存入题库"）→ 版本管理（基于任意版本新建 v2/v3…、恢复历史版本 = 新建记录、查看版本演化关系）→ 共享（题库级或单题级，按用户名，只读复用）→ 从题库把指定版本**快照**进问卷（内容固定，题库后续更新/归档/撤销共享不影响问卷）→ 查看使用关系（哪些问卷在用、用的哪个版本）→ 跨问卷统计（按口径合并本人问卷的作答）。
3. **归档恢复链路**：题目归档（列表与选题入口隐藏，不影响已使用问卷）→ 勾选「显示已归档」→ 打开详情 → 取消归档 → 恢复正常使用。

运行方式见「快速开始」；浏览器验收步骤见 `docs/runbook.md`；需求与业务规则（Q1–Q9、T1–T7）见 `docs/requirements.md`。

### 2. 数据库设计（MongoDB）

**集合总览**：

| 集合 | 内容 | 关系 |
| --- | --- | --- |
| `users` | 用户账号 | — |
| `surveys` | 问卷（题目嵌入，含题库来源字段） | `ownerId` → users；`questions[].sourceQuestionId` → questions |
| `responses` | 答卷（独立存储） | `surveyId` → surveys；`respondentId` → users（匿名时为 null） |
| `question_banks` | 题库（共享与组织的最小单元） | `ownerId` → users；`sharedWith[].userId` → users |
| `questions` | 逻辑题目主记录（稳定身份，不含内容） | `bankId` → question_banks；`sharedWith[].userId` → users（单题共享） |
| `question_versions` | 题目版本（不可变内容唯一载体） | `questionId` → questions；`parentVersionNo` 自引用演化链 |
| `sessions` | 会话（connect-mongo 基础设施，7 天 TTL） | — |

**各集合关键字段**：

- `users`：`_id`、`username`（唯一，3–20 字符不含空白）、`passwordHash`（bcrypt）、`createdAt`。
- `surveys`：`ownerId`、`title`、`description`、`allowAnonymous`、`allowRepeat`、`status`（draft / published / closed）、`publishedAt`、`closedAt`、`deadline`（纯时间维度，惰性判断）、`createdAt` / `updatedAt`、`questions[]`（嵌入题目数组）。
  - `Question` 子文档：`_id`（稳定 ID，跳转与答案都引用它）、`type`（single / multi / text / number）、`title`、`required`、`options[{_id, label}]`（选项 ID 同样稳定）、`minSelect` / `maxSelect`（多选数量限制）、`minLength` / `maxLength`（文本字数）、`minValue` / `maxValue` / `integerOnly`（数字范围与整数）、`jumps[]`（跳转规则）；**从题库添加的题目另有**：`sourceQuestionId`、`sourceVersionNo`、`sourceCaliberKey`（快照时刻口径）、`addedAt`（使用关系创建时间）。
  - `JumpRule` 子文档：`targetQuestionId`（只允许向后）、`matchMode`（多选 any / all，默认 any）、`conditions`（单选=选中选项 id；多选=选项 id 集合；数字=六种比较运算符 `eq/ne/lt/lte/gt/gte` + 值）。
- `responses`：`surveyId`、`respondentId`（问卷允许匿名时为 null）、`repeatAllowed`（提交时从问卷拷贝的冗余配置，供数据库层 partial unique 索引兜底并发重复提交）、`submittedAt`、`answers[{questionId, value}]`（value 按题型：选项 ObjectId / 选项 ObjectId 数组 / 字符串 / 数值；只保存实际作答的题，被跳过的题不出现）。
- `question_banks`：`ownerId`、`name`（1–50 字符）、`description`、`sharedWith[{userId, canEdit, grantedAt}]`（首期只读，canEdit 恒 false）、`scope`（预留团队扩展）、时间戳。
- `questions`：`ownerId`、`bankId`（一道题只属于一个题库）、`type` / `title`（冗余最新版本信息，列表展示）、`latestVersionNo`（仅展示，读取自愈）、`versionCount`（版本号分配计数器，`$inc` 原子分配）、`status`（active / archived）、`sharedWith[{userId, grantedAt}]`（单题共享）、时间戳。
- `question_versions`：`questionId`、`versionNo`（1 起递增，与 questionId 组成唯一索引；允许空缺、永不回收）、`parentVersionNo`（基于哪个版本创建，v1 为 null；恢复历史版本 = 以被恢复版本为 parent 新建记录）、`content`（完整题目内容：type/title/required/options/各题型约束；不含 `_id` 与 jumps——jumps 是问卷局部结构，快照进问卷时清空）、`statsCaliber {caliberKey, caliberLabel}`（显式统计口径声明：新建版本默认继承父版本，声明"口径变更"时生成新 key，覆盖单位/概念改变等机器无法判断的语义变化）、`clientToken`（可选幂等键）、`changeNote`、`createdBy`、`createdAt`。**版本一经插入不可覆盖、不可删除**（除题目删除时级联）。

**设计理由**（为什么这样设计、为什么适合 MongoDB）：

1. **问卷 ↔ 题目：嵌入。** 题目与问卷是组合关系，填写、校验、跳转、统计总是整卷一次读；嵌入后单文档读取即可，无需 join。
2. **问卷 ↔ 答卷：引用 `surveyId`。** 答卷随提交无上限增长，独立集合避免触碰 16MB 文档上限，写入答卷与编辑问卷互不竞争。
3. **题库三集合各司其职。** 题库是共享与组织的容器；逻辑题目提供稳定身份（跨问卷复用、使用关系、跨问卷统计都靠它）；版本是不可变内容链（历史可追溯、可恢复）。三者不合并：版本随演进无上限增长、题目列表需要轻量查询、共享授权与题库同生命周期。
4. **快照冗余有明确目的。** 问卷里的题目是题库版本的完整拷贝——这是"旧问卷不因改题而变"的物理保证，也与本项目 `repeatAllowed` 冗余先例一致；冗余都有记录在案。
5. **使用关系不建集合。** 由 `surveys.questions.sourceQuestionId` 多键索引派生查询，问卷增删/状态变化自动反映，无同步维护成本。
6. **旧数据零迁移。** 题库功能上线前的问卷题目没有来源字段，天然视为"独立题目"，行为与升级前完全一致；历史答卷含义不变（答案引用问卷内稳定 ID）。

**索引清单**：

| 集合 | 索引 | 用途 |
| --- | --- | --- |
| users | `{username:1}` unique | 注册/登录唯一性 |
| surveys | `{ownerId:1, updatedAt:-1}` | 我的问卷列表 |
| surveys | `{'questions.sourceQuestionId':1}`（multikey） | 题目使用关系派生查询 |
| responses | `{surveyId:1, submittedAt:1}` | 统计聚合 |
| responses | `{surveyId:1, respondentId:1}` | 重复填写判重 |
| responses | `{surveyId:1, respondentId:1}` **unique**（partial：`respondentId` 为 ObjectId 且 `repeatAllowed:false`） | 不允许重复填写时的数据库层并发兜底 |
| question_banks | `{ownerId:1, updatedAt:-1}`；`{'sharedWith.userId':1}` | 我的题库 / 共享给我的题库 |
| questions | `{bankId:1, updatedAt:-1}`；`{ownerId:1}`；`{'sharedWith.userId':1}` | 题库题目列表 / 按所有者 / 共享给我的题目 |
| question_versions | `{questionId:1, versionNo:1}` **unique** | 版本号唯一（$inc 分配 + 索引兜底） |
| question_versions | `{questionId:1, parentVersionNo:1}` | 版本演化关系 |
| question_versions | `{questionId:1, clientToken:1}` **unique**（partial：clientToken 存在） | 幂等重试防重复建版本 |

字段级说明见 `docs/database.md`（含嵌入与引用理由、冗余用途、生命周期语义、口径模型）。

### 3. API 说明

除注册/登录外所有接口要求登录（会话 cookie）。错误统一 `{ "error": "信息" }`。状态码约定：**400** 输入非法；**401** 未登录；**403** 权限不足/状态不允许；**404** 不存在或无权（不泄露存在性）；**409** 冲突（结构锁定/并发修改/重复提交/被使用禁止删除）。

**认证 `/api/auth`**

| 端点 | 说明 |
| --- | --- |
| POST /api/auth/register | 注册（用户名 3–20 字符不含空白、密码 ≥6 位；409 重名） |
| POST /api/auth/login | 登录，返回会话 cookie（401 凭据错误） |
| POST /api/auth/logout | 退出 |
| GET /api/auth/me | 当前用户 |

**问卷 `/api/surveys`（仅所有者可管理）**

| 端点 | 说明 |
| --- | --- |
| GET /api/surveys | 我的问卷列表（含有效状态 draft/published/closed/expired） |
| POST /api/surveys | 创建问卷（标题必填；说明/匿名/重复开关） |
| GET /api/surveys/:id | 详情（题目含选项/各题型配置/跳转/题库来源字段） |
| PATCH /api/surveys/:id | 改标题/说明/截止时间（ISO 8601，过去时间拒绝；null 清除） |
| POST /api/surveys/:id/questions | 草稿添加题目（四种题型及校验配置） |
| POST /api/surveys/:id/questions/from-bank | 从题库添加题目（指定版本，快照进问卷，jumps 清空） |
| PUT /api/surveys/:id/questions/:qid/jumps | 设置题目跳转规则（整体替换；目标必须存在且向后） |
| POST /api/surveys/:id/publish | 发布（至少一题；结构校验；截止已过拒绝） |
| POST /api/surveys/:id/close | 主动关闭（幂等；关闭后保持关闭） |

**填写 `/api/fill`（登录）**

| 端点 | 说明 |
| --- | --- |
| GET /api/fill/:id | 填写页数据（403 未发布/已关闭/已截止） |
| POST /api/fill/:id/submit | 提交答卷（服务端重算路径并最终校验；400 指明题目与原因；409 不允许重复时已提交） |

**统计 `/api/stats`（仅所有者）**

| 端点 | 说明 |
| --- | --- |
| GET /api/stats/:id | 问卷统计（总答卷数 + 每题的选项人数/次数/文本内容/数字平均值/回答人数） |

**题库 `/api/banks`（owner=所有者，viewer=共享只读，none=404）**

| 端点 | 说明 |
| --- | --- |
| GET /api/banks | 我的题库 + 共享给我的题库 |
| POST /api/banks | 建库（名称 1–50 字符） |
| GET / PATCH / DELETE /api/banks/:id | 详情（owner 可见共享列表）/ 改名与说明 / 删除（非空 409） |
| POST /api/banks/:id/share · DELETE /api/banks/:id/share/:userId | 按用户名共享（只读）/ 取消共享 |
| GET /api/banks/:id/questions | 题库题目列表 |
| POST /api/banks/:id/questions | 新建题目（v1，可带口径名称与版本说明） |
| POST /api/banks/:id/questions/from-survey | 从问卷存入题库（v1，剥离 jumps，选项 id 保留） |

**题目与版本 `/api/questions`（owner/viewer 可读；写操作仅 owner）**

| 端点 | 说明 |
| --- | --- |
| GET /api/questions/shared | 共享给我的题目列表（单题共享入口） |
| GET /api/questions/:id | 详情（最新版本内容 + 口径 + 角色；owner 附共享清单） |
| GET /api/questions/:id/versions | 版本列表（版本号/父版本/口径/说明/时间） |
| GET /api/questions/:id/versions/:vNo | 单个版本完整内容 |
| POST /api/questions/:id/versions | 基于指定版本创建新版本（口径默认继承，可声明变更；`clientToken` 幂等） |
| POST /api/questions/:id/versions/:vNo/restore | 恢复历史版本 = 新建记录（parent=被恢复版本） |
| POST /api/questions/:id/archive · /unarchive | 归档（列表与选题入口隐藏）/ 取消归档 |
| POST /api/questions/:id/share · DELETE /api/questions/:id/share/:userId | 单题共享 / 取消（与题库共享独立） |
| DELETE /api/questions/:id | 删除（被问卷使用 → 409；未使用 → 版本级联删除） |
| GET /api/questions/:id/usages | 使用关系（本人问卷标题可见；他人问卷仅状态/版本/时间） |
| GET /api/questions/:id/cross-stats | 跨问卷统计（仅本人问卷；?versionNo= 单版本；按口径+签名分组，数字加权均值） |

全部端点（请求体、响应结构、错误码）见 `docs/api.md`。

### 4. 关键逻辑说明

**① 认证**：密码只存 bcrypt 哈希（cost 10）；登录成功后会话存 MongoDB（connect-mongo）；所有业务接口共用 `requireAuth` 中间件；填写一律需登录（匿名仅指答卷不记录身份）。

**② 题型注册表**（`services/question-types.js`）：每种题型集中登记 5 个函数——`buildFromInput`（构造字段）、`validateStructure`（结构校验：单选/多选选项 ≥2 且不重复、多选数量限制合法、文本字数、数字范围与整数）、`validateAnswer`（答案校验）、`normalizeValue`（值规范化：选项 id 转 ObjectId 等）、`buildStats`（统计实现）。新增题型只需在此登记，校验/提交/统计自动生效；所有规则读取 MongoDB 中题目配置，不针对具体问卷写死。

**③ 结构校验与跳转**（`validation.js` + `services/resolve-jumps.js`）：
- 保存与发布时整卷校验；跳转规则强制"目标存在且只允许向后"（Q4），条件形态必须与题型匹配（单选=选项 id、多选=选项 id 集合 + any/all、数字=六种运算符 + 数值），文本题不允许跳转；非法配置拒绝保存与发布，无法绕过前端进入数据库。
- 填写时按规则顺序求值、**首条命中即跳转**（Q3）；提交时服务端**重新计算合法填写路径**，路径外（被跳过/未到达）的答案一律拒绝——客户端伪造跳转路径无法得逞，统计不会混入被跳过题的答案。

**④ 提交策略**（`services/submit.js`）：生命周期判断（未发布/已关闭/已截止 → 403）→ 答案最终校验（必答、多选数量、文本字数、数字范围与整数、无效选项、空答案拦截）→ 重复限制（不允许重复时应用层 409 + 数据库层 partial unique 索引兜底并发竞态）→ 保存（匿名问卷 `respondentId=null`；空答案不落库）。

**⑤ 生命周期**（`services/lifecycle.js`）：发布状态、主动关闭状态、截止时间三者分离统一判断；截止时间纯时间维度、提交时惰性判断（无需定时任务）；关闭后保持关闭；截止时间可延期、过去时间与无效格式拒绝。

**⑥ 统计**：直接聚合 `responses`（不做统计缓存），单选=各选项人数、多选=各选项被选次数（答卷内去重）、文本=内容列表、数字=平均值（分母为作答人数）；被跳过的题不计入回答人数。

**⑦ 题库权限模型**（`services/bank-access.js`）：owner（全部操作）/ viewer（查看、复用、使用关系、跨问卷统计）/ none（对外一律 404）。**题库级共享与单题级共享是两套独立授权**：任一授权即可只读访问与复用；取消其一不影响另一；被共享者不能修改题目（建版本/恢复/归档/删除/转共享一律 403）。

**⑧ 题目版本管理**（`services/question-versions.js`）：
- **不可变**：版本一经插入无更新/删除接口，内容永不覆盖；
- **版本号并发安全**：`versionCount` `$inc` 原子分配 + `{questionId, versionNo}` 唯一索引；失败不回退计数器，空缺号永不回收（被问卷引用的版本必须永远可查）；
- **幂等重试**：`clientToken` partial unique 索引，同 token 重试返回同一版本，不产生重复版本；
- **自愈**：`latestVersionNo` 仅展示用，读取时按实际最大版本号自愈收敛；
- **恢复** = 以历史版本为 parent 新建一条记录（完整保留 v1→v2→v3 演化链）；选项 id 跨版本稳定（编辑沿用旧 id、新增生成新 id），保证跨版本答案可比。

**⑨ 快照隔离（旧问卷不变的关键机制）**：从题库添加题目 = 深拷贝指定版本内容 + 新题目 id + 选项 id 原样保留 + `jumps` 清空（跳转目标属问卷局部结构）+ 记录来源（题目/版本/口径/时间）。此后该题与题库物理隔离：题库新建版本、恢复、归档、撤销共享都不影响已加题的问卷；发布问卷的题目结构被锁定（Q5），历史答卷始终按问卷内快照解读。A 问卷用 v1、B 问卷用 v2、创建 v3，三者互不影响。

**⑩ 归档与删除**：归档只改状态（列表与选题入口隐藏，可勾选「显示已归档」从详情取消归档，恢复后回到正常列表与选题入口）；被任一问卷使用的题目禁止删除（409，防止快照来源悬空）；未使用题目删除按"先删版本再删主记录"顺序级联，重试幂等、不产生孤立版本；非空题库禁止删除。

**⑪ 使用关系**：由 `surveys.questions.sourceQuestionId` 多键索引派生查询（无冗余使用表）；他人问卷的标题隐藏（T2），仅返回状态/版本/加入时间。

**⑫ 跨问卷统计口径**（`services/question-stats.js`）：
- **范围**：仅聚合请求者本人的问卷（T1 隐私边界——不能因有权访问某道共享题就读取他人问卷的答卷）；
- **分组**：组键 = 快照 `sourceCaliberKey`（显式口径声明）+ 内容签名（type + 有序选项 label + 各题型约束；不含标题/必答/跳转/选项 id）；**合并必须两者同时一致**——口径声明只能拆组（单位/概念改变），内容签名不同必然拆组（选项含义、顺序、约束改变），绝不按标题强行合并；
- **聚合**：单选/多选按 label 跨卷对齐相加；文本附来源问卷与时间；数字为跨卷原始答案聚合（均值 = 总和/总数，绝不平均各卷均值）+ count/min/max；
- **缺失口径**：每组报告纳入问卷数、每卷答卷数/作答数/未作答数及解释；支持 `?versionNo=` 单版本查询。

**⑬ 并发安全**：问卷添加题目/设置跳转采用"读取 → 校验 → updatedAt 守卫条件更新 → 失败重试"；重复提交由 partial unique 索引兜底；版本号由 `$inc` 分配；均为实测验证过的机制（对应回归测试在 `server/test/`）。

**⑭ 兼容与回滚**：题库功能对旧数据零迁移（旧题目无来源字段 = 独立题目，历史答卷含义不变）；`scripts/rollback-question-bank.js` 可删除三个新集合回滚（问卷快照自包含，填写与统计不受影响）；第一阶段全部 71 项自动化测试零修改持续通过。

详细见 `docs/database.md`（版本/口径/权限模型）、`docs/requirements.md`（Q1–Q9、T1–T7 已确认规则）、`docs/api.md`（端点明细）。

## 详细文档索引

| 文档 | 内容 |
| --- | --- |
| `CLAUDE.md` | 长期技术约束与协作规则 |
| `docs/requirements.md` | 需求、业务规则（Q1–Q9、T1–T7 已确认）、实现进度 |
| `docs/database.md` | MongoDB 集合/字段/索引、嵌入与引用理由、版本/口径/权限模型 |
| `docs/api.md` | 全部 HTTP 接口说明 |
| `docs/runbook.md` | 本地启动与浏览器验收步骤（含题库功能验收） |
| `docs/testing.md` | 测试清单、运行方式与实际证据位置 |
| `docs/ai-log.md` | 每轮真实开发记录（含失败与修复） |
| `docs/evidence/question-bank/` | 题库功能真实浏览器验收证据（脚本、截图、结果 JSON、重跑方式） |
| `scripts/rollback-question-bank.js` | 题库功能回滚脚本（`node scripts/rollback-question-bank.js --yes`） |


