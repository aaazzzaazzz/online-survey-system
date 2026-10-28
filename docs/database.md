# 数据库设计（v0.3，含题库与题目版本）

> 与 `docs/requirements.md` 同步维护。所有业务数据持久化于 MongoDB。

## 1. 部署与环境

- 数据库：`survey_system`（主库）、`survey_system_test`（测试库，测试自动重建）。
- 数据目录：**`D:\MongoDB\survey-data`**（2026-10-16 用户指定，专用于本项目；不使用、不修改用户原有的 MongoDB 数据目录）。
- 启动方式：`scripts\start-mongo.bat`，等价命令：
  `mongod --dbpath "D:\MongoDB\survey-data" --port 27017 --bind_ip 127.0.0.1 --logpath "D:\MongoDB\survey-data\mongod.log" --logappend`
- 停止：`scripts\stop-mongo.bat`（mongosh shutdown）。
- sessions 集合由 connect-mongo 自动创建，属基础设施，不在业务设计中展开。

## 2. 集合总览

| 集合 | 内容 | 关系 |
| --- | --- | --- |
| `users` | 用户账号 | — |
| `surveys` | 问卷（题目嵌入，含题库来源字段） | `ownerId` → users；`questions[].sourceQuestionId` → questions |
| `responses` | 答卷（独立存储） | `surveyId` → surveys；`respondentId` → users（可空） |
| `question_banks` | 题库（共享与组织单元，第 14 轮新增） | `ownerId` → users；`sharedWith[].userId` → users |
| `questions` | 逻辑题目主记录（稳定身份，不含内容，第 14 轮新增） | `bankId` → question_banks；`ownerId` → users |
| `question_versions` | 题目版本（不可变内容唯一载体，第 14 轮新增） | `questionId` → questions；`parentVersionNo` 自引用演化链 |

## 3. users

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `_id` | ObjectId | 主键 |
| `username` | string | 必填，trim，全局唯一（unique 索引）；3–20 字符、不含空白（Q9） |
| `passwordHash` | string | bcrypt 哈希（cost 10），绝不存明文 |
| `createdAt` | Date | 注册时间 |

## 4. surveys（题目嵌入）

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `_id` | ObjectId | 主键；同时用于独立填写链接 `/survey/:surveyId` |
| `ownerId` | ObjectId | 必填，引用 users._id；仅所有者可管理、查看统计 |
| `title` | string | 必填 |
| `description` | string | 可空 |
| `allowAnonymous` | bool | 是否允许匿名填写。**Q1 已确认：true 时答卷不记录 respondentId（填写仍需登录）** |
| `allowRepeat` | bool | 是否允许重复填写（Q6：false 时第二次提交被拒绝） |
| `status` | string | `draft`（未发布）/ `published`（已发布且未手动关闭）/ `closed`（已发布后被创建者手动关闭） |
| `publishedAt` | Date \| null | 首次发布时间（发布状态标志；**Q5：发布后题目结构锁定**） |
| `closedAt` | Date \| null | 主动关闭时间（第 7 轮新增，旧数据无此字段，兼容；重新开放功能已按需求收敛移除，closedAt 保留为关闭时刻记录） |
| `deadline` | Date \| null | 截止时间（纯时间维度，独立于 status）；填写页访问与提交时惰性判断（Q7），无需定时任务；前后端统一 ISO 8601，服务端解析存储，无效格式与过去时间被拒绝 |
| `createdAt` / `updatedAt` | Date | 创建 / 最后修改时间 |
| `questions` | Question[] | 嵌入题目数组，数组顺序即题目顺序 |

### Question 子文档

```
{
  _id: ObjectId,              // 应用生成；跳转目标、答案引用均使用此 id
  type: "single" | "multi" | "text" | "number",
  title: string,              // 题干
  required: bool,             // 是否必答
  options: [{ _id: ObjectId, label: string }],   // single/multi 用；顺序即展示顺序
  minSelect: int | null,      // multi：最少选择数（null = 不限）
  maxSelect: int | null,      // multi：最多选择数（null = 不限）；min == max 即"恰好"
  minLength: int | null,      // text：最少字数（按 Unicode 码点计）
  maxLength: int | null,      // text：最多字数
  minValue: number | null,    // number：最小值
  maxValue: number | null,    // number：最大值
  integerOnly: bool,          // number：是否必须为整数
  jumps: JumpRule[],          // 按数组顺序求值，首条命中即跳转（Q3 已确认）
  // —— 以下为"从题库添加"时写入的来源字段（第 14 轮，仅快照题目存在；旧题目无这些字段）——
  sourceQuestionId: ObjectId, // 来源逻辑题目 questions._id（复用追溯与使用关系）
  sourceVersionNo: int,       // 使用的具体版本号（快照即固定，之后题库更新不影响本题）
  sourceCaliberKey: ObjectId, // 快照时刻的统计口径标识（跨问卷统计分组以快照为准）
  addedAt: Date,              // 使用关系创建时间
}
```

旧数据兼容：第 14 轮前的问卷题目没有来源字段，视为"独立题目"（不属于任何题库），无任何迁移；历史答卷含义不变（answers.questionId / optionId 引用均未变）。

### JumpRule 子文档

```
{
  targetQuestionId: ObjectId,   // 目标题；只允许向后跳（Q4 已确认，保存时校验）
  matchMode: "any" | "all",     // multi 用（Q2 已确认：any/all，默认 any）；single/number 不需要
  conditions: [
    { optionId: ObjectId },                              // single：选中该选项
    { optionIds: [ObjectId] },                           // multi：与 matchMode 配合
    { op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte", value: number }  // number（Q8 已确认全 6 种）
  ]
}
```

说明：按题型只允许对应形态的 conditions；single / multi / number 可配置跳转，text 不支持（需求 1.4）。跳转目标超过最后一题时直接进入提交。

### 生命周期语义（第 7 轮确认，避免用一个布尔字段混合所有状态）

三个概念分离：**发布状态**（`status` draft/published + `publishedAt`）、**主动关闭状态**（`status` closed + `closedAt`）、**截止时间**（`deadline`，纯时间判断）。

- 填写开放 = `published` 且未 `closed` 且 `now ≤ deadline`（统一判断在 `services/lifecycle.js`）。
- 发布时若截止时间已过则拒绝发布。
- 关闭与截止判断均不触碰 responses 数据；关闭后问卷保持关闭。
- 截止时间可修改（延期）或清除；过去时间与无效格式被拒绝。
- 重新开放与复制问卷属范围外功能，已按需求收敛移除（2026-10-17，见 ai-log 第 12 轮）；相关字段 closedAt 保留、无迁移影响。

## 5. responses（答卷）

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `_id` | ObjectId | 主键 |
| `surveyId` | ObjectId | 必填，索引 `{surveyId, submittedAt}` |
| `respondentId` | ObjectId \| null | **Q1 已确认**：问卷 allowAnonymous=true 时为 null，否则为填写人 id |
| `repeatAllowed` | bool | 必填；提交时从问卷 allowRepeat 拷贝的冗余配置（B1），供 partial unique index 表达"不允许重复"的唯一性条件 |
| `submittedAt` | Date | 提交时间 |
| `answers` | Answer[] | 实际作答；只含有作答的题，被跳过的题不出现 |

### Answer 子文档

```
{
  questionId: ObjectId,
  value: ObjectId | [ObjectId] | string | number   // 按题型
}
```

## 6. 题库与题目版本（第 14 轮新增，只增不改现有集合）

### question_banks（题库：共享与组织单元）

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `_id` | ObjectId | 主键 |
| `ownerId` | ObjectId | 所有者（引用 users） |
| `name` | string | 必填，1–50 字符 |
| `description` | string | 可空 |
| `sharedWith` | [{userId: ObjectId, canEdit: bool, grantedAt: Date}] | 共享授权（T4 已确认：首期只读，canEdit 恒 false，字段为未来 editor 角色预留） |
| `scope` | string | `personal`（预留未来 `team` + teamId 扩展团队题库） |
| `createdAt` / `updatedAt` | Date | — |

个人题库 = 自己创建的 banks；共享题库 = `sharedWith` 含自己的他人 banks。

### questions（逻辑题目主记录：稳定身份，不含内容）

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `_id` | ObjectId | 逻辑题目稳定 ID（跨问卷复用、使用关系、跨问卷统计都靠它） |
| `ownerId` | ObjectId | 所有者（= 所属题库所有者） |
| `bankId` | ObjectId | 所属题库（一道题只属于一个题库） |
| `type` / `title` | string | 冗余最新版本信息，列表展示用（新版本创建时随 `$set` 更新） |
| `latestVersionNo` | int | 最新版本号（仅展示；`$max` 更新 + 读取自愈，不参与分配） |
| `versionCount` | int | 版本分配计数器：新版本号 = `$inc` 返回值（原子、并发互异；失败不回退，空缺号不回收） |
| `status` | string | `active` / `archived`（归档仅从列表与选择器隐藏，不影响已使用问卷） |
| `sharedWith` | [{userId: ObjectId, grantedAt: Date}] | 单题共享（第 20 轮）：题库授权与单题授权任一即可只读复用；取消题库共享不影响单题授权，反之亦然 |
| `createdAt` / `updatedAt` | Date | — |

### question_versions（不可变版本：内容唯一载体）

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| `_id` | ObjectId | 主键 |
| `questionId` | ObjectId | 归属逻辑题目 |
| `versionNo` | int | 1 起递增；`{questionId, versionNo}` unique；允许空缺、永不回收（问卷引用必须永远可查） |
| `parentVersionNo` | int \| null | 基于哪个版本创建（v1 为 null）；恢复历史版本 = 以被恢复版本为 parent 新建记录 |
| `content` | Question 内容（不含 `_id` / `jumps`） | 题目完整内容快照：type/title/required/options（选项 id 跨版本稳定：编辑沿用旧 id、新增生成新 id）/各题型约束。**插入后不可变：无更新/删除接口**。jumps 是问卷局部结构，不入题库（快照进问卷时清空，T3） |
| `statsCaliber` | {caliberKey: ObjectId, caliberLabel: string} | 显式统计口径声明：新建版本默认继承父版本；`caliberChanged` 时生成新 key。覆盖机器无法判断的语义变化（单位/概念改变） |
| `clientToken` | string \| 无 | 可选幂等键：partial unique `{questionId, clientToken}`，重试不会重复建版本 |
| `changeNote` / `createdBy` / `createdAt` | — | 版本说明 / 创建者 / 创建时间 |

### 使用关系（无独立集合）

使用关系由 `surveys.questions.sourceQuestionId` 多键索引**派生查询**（`GET /api/questions/:id/usages`）：不冗余一份"使用表"，问卷删除/状态变化自动反映；`addedAt` 即使用关系创建时间。被任何问卷使用的逻辑题目禁止删除（409，T5；日常操作优先归档）。

### 跨问卷统计口径（T1 已确认：仅聚合请求者本人的问卷）

分组键 = 快照 `sourceCaliberKey` + 快照内容签名（type + 有序选项 label + 各题型约束；不含 title/required/jumps/选项 id）。合并必须口径与签名**同时**相同：显式口径只能拆组（单位/概念改变），不能强行合并；内容变化（label、选项顺序、约束、题型）必然拆组。数字合并为跨卷原始答案聚合（均值 = 总和/总数），多选/单选按 label 对齐相加。

## 7. 嵌入与引用的选择及理由

1. **问卷 ↔ 题目：嵌入。** 题目与问卷是组合关系：题目只属于一份问卷；编辑、填写、校验、跳转解析总是整卷一起读；无跨问卷复用需求。嵌入后一次查询得到完整问卷，无需组装。若拆成独立 questions 集合，每次读取都要按问卷取题、排序、拼装，纯增复杂度、无收益。
2. **问卷 ↔ 答卷：引用 surveyId。** 两者生命周期与增长速率不同：答卷数量随时间无上限增长，若嵌入问卷文档将触碰 16MB 文档上限，且"编辑问卷"与"写入答卷"会互相竞争同一文档；独立集合可并行写入、按 surveyId 聚合统计。
3. **用户 ↔ 问卷：引用 ownerId。** 双向独立变化；不在 user 文档嵌入问卷数组（同样的膨胀问题），也不需要反向冗余。

这种组织贴合 MongoDB 的文档模型：把"一次操作要一起读的聚合"放进一个文档（问卷 + 题目），把"独立增长、独立访问路径"的实体分开（用户、答卷），而不是把关系表结构原样搬成集合。

## 8. 冗余及其用途

- **repeatAllowed 冗余（B1 已修复）**：答卷在提交时拷贝问卷的 allowRepeat 配置。用途：partial unique index 无法引用 surveys 文档，跨文档唯一性条件必须冗余到答卷自身；同时把约束锁定为"提交时刻的配置"。匿名答卷（respondentId 为 null）不受影响。
- **答案快照：本轮不存储。** Q5 已确认发布后锁定题目结构，题目/选项在发布后不可变，答卷中的 questionId/optionId 可通过问卷文档稳定解读，无需快照。若未来放宽 Q5（发布后可改结构），再补快照字段。
- **不做统计缓存**：统计直接聚合 responses，保证"基于真实答卷"且无一致性问题；量级增大后再考虑预聚合（后续迭代）。

## 9. 索引

| 集合 | 索引 | 用途 |
| --- | --- | --- |
| users | `{username: 1}` unique | 注册 / 登录唯一性 |
| surveys | `{ownerId: 1, updatedAt: -1}` | 我的问卷列表 |
| surveys | `{status: 1, deadline: 1}` | 截止扫描（如需要） |
| surveys | `{'questions.sourceQuestionId': 1}`（multikey，第 14 轮） | 题目使用关系派生查询 / 删除前引用检查 / 跨问卷统计入口 |
| responses | `{surveyId: 1, submittedAt: 1}` | 统计范围扫描与分页 |
| responses | `{surveyId: 1, respondentId: 1}` | 应用层重复填写判重查询 |
| responses | `{surveyId: 1, respondentId: 1}` **unique**，partialFilterExpression `{respondentId: {$type: 'objectId'}, repeatAllowed: false}`，名称 `unique_respondent_per_survey_when_no_repeat` | **B1**：不允许重复填写的数据库层兜底；匿名与允许重复的答卷不受限 |
| question_banks | `{ownerId: 1, updatedAt: -1}`；`{'sharedWith.userId': 1}` | 我的题库列表；共享给我的题库列表 |
| questions | `{bankId: 1, updatedAt: -1}`；`{ownerId: 1}`；`{'sharedWith.userId': 1}` | 题库内题目列表；按所有者查询；共享给我的题目列表（第 20 轮） |
| question_versions | `{questionId: 1, versionNo: 1}` **unique** | 版本号唯一（$inc 分配 + 索引兜底）；按版本读取 |
| question_versions | `{questionId: 1, parentVersionNo: 1}` | 版本演化关系 / 分支查询 |
| question_versions | `{questionId: 1, clientToken: 1}` **unique**，partialFilterExpression `{clientToken: {$exists: true}}`，名称 `unique_client_token_per_question` | 幂等重试：同 token 只建一个版本 |

说明：重复填写双重保障——应用层在提交时判重并返回明确业务错误（409）；数据库层由 partial unique index + 答卷冗余的 repeatAllowed 兜底并发竞态（B1 已修复，唯一索引冲突 11000 在 `services/submit.js` 中转为 409，不向客户端泄露数据库异常）。索引在 `server/src/db.js` 中集中创建，与本表保持一致。

## 10. 约束与校验分层

- 结构约束（标题必填、选项 ≥ 2、label 非空、跳转目标存在且向后（Q4）等）在应用层统一校验（`server/src/validation.js`），保存问卷时执行。
- 答案校验（必答、选项有效、多选数量、字数、数字范围 / 整数）在提交时按题型执行（`services/validate-answers.js`），以提交时刻的问卷配置为准。
- MongoDB 不重复定义这些校验（避免校验逻辑两处维护）；MongoDB 只承担唯一索引等数据层约束。
- 数字以 JS Number（double）存储；integerOnly 时先校验整数。

## 11. 已确认落点与遗留说明

- Q1：`responses.respondentId` 在 allowAnonymous=true 时为 null；填写一律需登录（fill 路由全部要求会话）。
- Q2/Q3/Q4/Q8：JumpRule 结构已定稿；结构校验已在 `validation.js` 实现（数据层），跳转编辑界面与运行解析在后续阶段实现。
- Q5：发布后题目结构锁定（API 层 409），标题/说明可改（PATCH），截止时间字段预留。
- Q6：提交策略在 `services/submit.js`（应用层判重 409 + DB 层 partial unique index 兜底并发竞态，B1 已修复）；Q7：deadline 惰性判断（设置入口后续阶段提供）。
- 多选/文本/数字题型结构已实现（第 5 轮）：多选统计按"答卷内选项去重"计数（重复选项在校验层拒绝）；数字统计分母 = 该题作答人数；文本字数按 Unicode 码点计；数字以 double 存储、integerOnly 时校验整数。
- 跳转已实现（第 6 轮）：jumps 存于 `surveys.questions[i].jumps`（targetQuestionId 与条件中的选项以 ObjectId 存储，matchMode 缺省 any）；结构校验在 `validation.js`（目标存在、只向后、条件形态与题型匹配、文本题拒绝、每条规则恰好一个条件，非法配置拒绝保存与发布）；路径解析在 `services/resolve-jumps.js`（按规则数组顺序首条命中）；提交校验在 `services/validate-answers.js` 按重新计算的路径执行，路径外（被跳过/未到达）的答案一律拒绝，保证统计不混入。
- 生命周期已实现（第 7 轮）：`closedAt` 字段新增（旧数据无该字段，兼容，无需迁移）；开放判断统一在 `services/lifecycle.js`（openness / effectiveStatus）；截止时间以 ISO 8601 输入、UTC Date 存储。
- 题目管理（第 12 轮收敛后）：仅保留"创建问卷时添加多道题目"与跳转规则配置；题目/选项稳定 ID 与跳转引用验证保留；发布后结构锁定保留。题目编辑/删除/排序、复制问卷、重新开放已按原始需求范围移除（对应 API 返回 404）。
- 数据模型无变化（无新字段、无迁移）；copyQuestions 已随复制功能移除。
