# 测试说明

> 测试用例即 `server/test/*.test.js`（代码内包含步骤、输入与断言预期）；实际运行输出与结果记录在各轮 `docs/ai-log.md`（第 4–9 轮）与本文末的最终验收运行记录。所有测试运行于**真实本地 MongoDB** 的独立测试库 `survey_system_test`，不使用 mock。

## 运行方式

```bash
# 前置：本地 MongoDB 运行中（scripts\start-mongo.bat）
cd server
npm test          # node --test --test-concurrency=1
```

- 每个测试文件在 `before()` 中 `dropDatabase`（`test/helpers.js` 的 `resetTestDb`），**不依赖既有测试数据**；
- 每个文件由 test runner 以独立进程运行，`--test-concurrency=1` 保证文件间串行；
- 测试不依赖执行顺序：正向（默认字母序）与反向文件顺序均实际运行通过（见下）。

## 测试清单（文件 → 覆盖）

| 文件 | 覆盖（步骤/输入/预期见文件内断言） |
| --- | --- |
| `auth.test.js` | 注册→登录→me；密码 bcrypt 哈希落库验证；Q9 用户名/密码规则；重复注册 409；错误密码 401；未登录访问 401 |
| `surveys.test.js` | 创建问卷与列表权限隔离；添加单选题与结构校验（选项不足/空/未知题型）；Q4 跳转结构直测（向后/目标不存在）；发布（无题 400/有题 200）；发布后锁定（Q5）；并发添加 5 题不丢失；权限隔离 |
| `fill.test.js` | 填写页可见性（已发布/未发布 403/不存在 404）；提交落库（值规范化、身份记录）；必答未答与无效选项 400；重复提交 409 不覆盖（Q6）；允许重复两份；匿名 respondentId=null（Q1）；并发提交恰好一成功（B1）；DB 层 partial unique index 直测与存在性 |
| `question-types.test.js` | 多选合法/少选/超最大/指定数量；文本合法/过短/过长；数字合法/低于最小/超过最大/整数限制；必答空 400；可选题空 201；非法选项；非法答案类型（数字字符串/多选字符串/文本数字）；空答案绕过拦截（验收新增）；三种新题型统计（真实聚合） |
| `jumps.test.js` | 单元：单选命中/未命中、any/all（默认 any）、六种运算符、多规则首条命中；API：规则存取与 ObjectId 落库、七类非法配置拒绝、发布校验；集成：合法跳过必答、伪造路径拒绝、旧路径失效、跳过题不入统计、数字+多选组合 |
| `lifecycle.test.js` | 截止时间设置/修改/清除（DB Date 与 UTC 值验证）、无效格式/过去时间拒绝；截止前后提交；无截止正常；草稿截止过期发布拒绝；主动关闭（closedAt 记录、答卷不受影响、重复关闭幂等、关闭后保持关闭）；未发布访问；权限 404；已移除接口（重开/复制）返回 404 |
| `question-management.test.js` | 创建时添加多道题目（四题型配置与稳定 ID）；跳转规则仍可配置；发布后加题锁定 409；权限 404；已移除接口（编辑/删除/排序）返回 404 |

## 最终验收运行记录（2026-10-17，实际输出）

| 运行 | 命令 | 实际结果 |
| --- | --- | --- |
| 正向全量 | `npm test` | **80/80 通过**（约 8.8 秒） |
| 反向文件顺序 | `node --test --test-concurrency=1 test/surveys.test.js test/stats.test.js test/question-types.test.js test/question-management.test.js test/lifecycle.test.js test/jumps.test.js test/fill.test.js test/auth.test.js` | **78/78 通过**（helpers.js 非测试文件，显式列文件时不计） |

## 测试证据位置

- 各轮完整测试输出节选：`docs/ai-log.md` 第 2–9 轮（含失败案例与修复过程，如 B1 并发修复、路由顺序 bug、空答案绕过修复）。
- 真实库 E2E 输出节选：`docs/ai-log.md` 各轮"真实 E2E"节（正式库 survey_system，验证后临时脚本已删除）。
