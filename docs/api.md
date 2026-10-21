# API 说明

> 与 `server/src/routes/` 当前实现一致（2026-10-17 最终验收核对）。除注册/登录外，所有接口要求登录（会话 cookie）；问卷管理与统计仅所有者可操作（非所有者返回 404，不泄露存在性）。错误统一为 `{ "error": "信息" }`。

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

## 页面

`/login.html`、`/surveys.html`、`/survey.html?id=`、`/survey/:id`（填写页）、`/stats.html?id=`；静态资源 `/api.js`、`/style.css`。

## 关键状态码约定

- 404：问卷/题目不存在或**非所有者**（不区分，避免泄露存在性）；**已按需求收敛移除的接口**（重新开放、复制问卷、题目编辑/删除/排序）同样返回 404。
- 409：已发布/关闭的结构锁定；并发修改冲突（updatedAt 守卫重试耗尽）；不允许重复填写时的第二次提交。
- 400：输入/配置非法，错误信息指明具体题目、规则与原因。
- 401：未登录。
- 403：填写/提交时问卷未发布、已关闭或已截止。
