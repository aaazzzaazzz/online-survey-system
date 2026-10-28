# API 说明

> 与 `server/src/routes/` 当前实现一致（2026-10-26 题库功能最终验收核对）。除注册/登录外，所有接口要求登录（会话 cookie）；问卷管理与统计仅所有者可操作（非所有者返回 404，不泄露存在性）；题库/题目接口按 owner/viewer 权限（T4 只读共享）。错误统一为 `{ "error": "信息" }`。

## 认证 `/api/auth`

| 方法/路径 | 请求体 | 成功 | 失败 |
| --- | --- | --- | --- |
| POST /api/auth/register | `{username, password}` | 201 `{id, username}` | 400 规则（用户名 3–20 字符不含空白；密码 ≥6）；409 用户名已占用 |
| POST /api/auth/login | `{username, password}` | 200 `{id, username}` + 会话 cookie | 401 |
| POST /api/auth/logout | — | 200 `{ok:true}` | — |
| GET /api/auth/me | — | 200 `{id, username}` | 401 |

## 问卷管理 `/api/surveys`（所有者）

| 方法/路径 | 请求体 | 成功 | 失败 |
| --- | --- | --- | --- |
| GET /api/surveys | — | 200 列表（含 `effectiveStatus`: draft/published/closed/expired） | 401 |
| POST /api/surveys | `{title, description?, allowAnonymous?, allowRepeat?}` | 201 `{id}` | 400 标题为空 |
| GET /api/surveys/:id | — | 200 详情（题目含 options/jumps/各题型配置） | 404 |
| PATCH /api/surveys/:id | `{title?, description?, deadline?}`（deadline 为 ISO 8601 或 null 清除） | 200 | 400 非法键/时间格式/过去时间；404 |
| POST /api/surveys/:id/questions | `{type, title, required, options?, minSelect?, maxSelect?, minLength?, maxLength?, minValue?, maxValue?, integerOnly?}` | 201 `{id}` | 400 结构非法；404；409 已发布锁定/并发冲突 |
| PUT /api/surveys/:id/questions/:qid/jumps | `{jumps: [{targetQuestionId, matchMode?, conditions: [单条件]}]}`（matchMode 缺省 any） | 200 | 400 目标不存在/只向后/条件形态非法；404；409 |
| POST /api/surveys/:id/questions/from-bank | `{bankQuestionId, versionNo?}`（缺省最新版） | 201 `{id}`（快照题目 id） | 400 结构非法；404 题目/版本不存在或无权；409 非草稿/并发冲突 |
| POST /api/surveys/:id/publish | — | 200 `{status:"published"}` | 400 无题/已发布/截止已过；404 |
| POST /api/surveys/:id/close | — | 200 `{status:"closed"}`（幂等） | 400 草稿不能关闭；404 |

## 填写 `/api/fill`（登录）

| 方法/路径 | 请求体 | 成功 | 失败 |
| --- | --- | --- | --- |
| GET /api/fill/:id | — | 200 填写数据（title/description/allowAnonymous/allowRepeat/deadline/questions 含 jumps） | 401；403 未发布/已关闭/已截止；404 |
| POST /api/fill/:id/submit | `{answers: [{questionId, value}]}`（value 按题型：单选=选项 id 字符串；多选=id 数组；文本=字符串；数字=数值） | 201 `{id}` | 400 校验错误（指明题目与原因；路径外答案/空答案拒绝）；403；404；409 不允许重复时已提交 |

## 统计 `/api/stats`（所有者）

| 方法/路径 | 成功 | 失败 |
| --- | --- | --- |
| GET /api/stats/:id | 200 `{surveyId, title, totalResponses, questions: [{questionId, type, title, answered, optionCounts?（单选/多选）, contents?（文本）, average?（数字）}]}` | 401；404 |

## 题库 `/api/banks`（登录；权限：owner=所有者，viewer=共享只读（T4），none=404）

| 方法/路径 | 请求体 | 成功 | 失败 |
| --- | --- | --- | --- |
| GET /api/banks | — | 200 `{mine:[…], sharedWithMe:[…]}`（各含 role） | 401 |
| POST /api/banks | `{name, description?}` | 201 `{id}` | 400 名称为空/超 50 字符 |
| GET /api/banks/:id | — | 200 详情；owner 附加 sharedWith（含用户名） | 404 |
| PATCH /api/banks/:id | `{name?, description?}` | 200 | 400 非法键/名称为空；403 非所有者；404 |
| DELETE /api/banks/:id | — | 200 | 403；404；409 题库中还有题目 |
| POST /api/banks/:id/share | `{username}` | 200（幂等） | 400 共享给自己/用户名为空；403；404 题库或用户不存在 |
| DELETE /api/banks/:id/share/:userId | — | 200 | 400 id 无效；403；404 |
| GET /api/banks/:id/questions | — | 200 `[{id, title, type, latestVersionNo, status, updatedAt}]` | 404 |
| POST /api/banks/:id/questions | `{type, title, required, options?, …各题型约束, changeNote?, caliberLabel?}` | 201 `{id, versionNo:1}` | 400 结构非法；403（T4 共享只读）；404 |
| POST /api/banks/:id/questions/from-survey | `{surveyId, questionId, changeNote?, caliberLabel?}` | 201 `{id, versionNo:1}`（内容剥离 jumps，选项 id 保留） | 400；403；404 |

## 题目与版本 `/api/questions`（登录；owner/viewer 可读，写操作仅 owner（T4））

| 方法/路径 | 请求体 | 成功 | 失败 |
| --- | --- | --- | --- |
| GET /api/questions/shared | — | 200 `[{id, title, type, latestVersionNo, status, bankName, grantedAt}]`（共享给我的题目，第 20 轮单题共享入口） | 401 |
| GET /api/questions/:id | — | 200 主记录 + latest 版本（content/statsCaliber）+ role（读取时自愈 latestVersionNo）；owner 附加 sharedWith（含用户名） | 404 |
| POST /api/questions/:id/share | `{username}` | 200（幂等） | 400 共享给自己/用户名为空；403 非所有者；404 题目或用户不存在 |
| DELETE /api/questions/:id/share/:userId | — | 200 | 400 id 无效；403 非所有者；404 |
| GET /api/questions/:id/versions | — | 200 `[{versionNo, parentVersionNo, caliberLabel, changeNote, createdAt}]` | 404 |
| GET /api/questions/:id/versions/:vNo | — | 200 版本完整内容 | 404 |
| POST /api/questions/:id/versions | `{baseVersionNo?, type, title, required, options?, …, changeNote?, caliberChanged?, caliberLabel?, clientToken?}` | 201 `{versionNo, idempotent:false}`；幂等重试 200 `{versionNo, idempotent:true}` | 400 结构非法/非法 clientToken；403；404 题目或基础版本不存在 |
| POST /api/questions/:id/versions/:vNo/restore | `{changeNote?, clientToken?}` | 201 `{versionNo, idempotent:false}`（新版本，parent=被恢复版本） | 400；403；404 |
| POST /api/questions/:id/archive · /unarchive | — | 200 | 403；404 |
| DELETE /api/questions/:id | — | 200（版本级联删除） | 403；404；409 被问卷使用（T5，请用归档） |
| GET /api/questions/:id/usages | — | 200 `[{surveyId, title?（仅本人问卷，T2）, status, effectiveStatus, sourceVersionNo, addedAt, canViewStats}]` | 404 |
| GET /api/questions/:id/cross-stats | `?versionNo=` 可选 | 200 `{questionId, title, groups: [{caliberKey, caliberLabel, signature, compatibleVersionNos, merged, surveyCount, totalResponses, answered, missing, missingExplanation, units: [{surveyId, title, status, sourceVersionNo, addedAt, responseCount, answeredCount, missingCount}], stats: {optionCounts?（按 label 对齐）/ contents?（带 surveyId/submittedAt）/ number?（count/mean/min/max）}}]}`（T1：仅本人问卷；合并需口径+签名同时相同；数字均值=总和/总数） | 404 |

## 页面

`/login.html`、`/surveys.html`、`/survey.html?id=`（含"从题库添加题目"入口）、`/banks.html`（题库管理：建库/共享/题目/版本历史/使用关系/跨问卷统计）、`/survey/:id`（填写页）、`/stats.html?id=`；静态资源 `/api.js`、`/style.css`。

## 关键状态码约定

- 404：问卷/题目不存在或**非所有者**（不区分，避免泄露存在性）；**已按需求收敛移除的接口**（重新开放、复制问卷、题目编辑/删除/排序）同样返回 404。
- 409：已发布/关闭的结构锁定；并发修改冲突（updatedAt 守卫重试耗尽）；不允许重复填写时的第二次提交；题库非空删除；被问卷使用的题目删除（T5）。
- 400：输入/配置非法，错误信息指明具体题目、规则与原因。
- 401：未登录。
- 403：填写/提交时问卷未发布、已关闭或已截止。
