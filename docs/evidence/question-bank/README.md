# 题库功能验收证据（第 15/16 轮）与独立重跑方式（第 18 轮）

> 真实浏览器（本机 Edge + puppeteer-core，headless）验收与回归的原始证据。
> 修复前与修复后分目录存放，原始失败记录未做任何改写。

## 目录结构

| 目录 | 内容 | 性质 |
| --- | --- | --- |
| `before-fix/` | 第 15 轮独立验收：`acceptance.js`（脚本）、`acceptance-results.json`（逐步骤记录）、`screenshots/`（21 张步骤截图） | **历史证据**（修复前执行）：18 项通过；2 个界面缺陷 FAIL（步骤 5b=D3、缺陷D1）；步骤 9 SKIP |
| `after-fix/` | 第 16 轮 D3/D1/D2 修复回归：`fix-regression.js`（脚本）、`results.json`（逐项记录）、`screenshots/`（9 张关键截图） | **历史证据**（修复后执行）：21 项通过 |
| `runs/` | 每次重跑的结果（时间戳子目录：脚本副本 + 截图 + results.json） | **新的执行结果**，永不覆盖上面两个历史目录 |
| `package.json` / `package-lock.json` | 依赖声明与锁定（puppeteer-core **25.14.0**，已在实际运行中验证的版本） | 可重复安装 |
| `run-acceptance.ps1` | Windows PowerShell 一键运行器（库名保护、独立验收服务、独立运行目录） | 见下 |

**历史证据与重跑结果的区别**：`before-fix/acceptance-results.json` 是第 15 轮在**修复前代码**上的真实执行记录（含 D3/D1 失败）。在**当前已修复代码**上重跑 `before-fix/acceptance.js` 得到的是**新的执行结果**（写入 `runs/`），步骤 5b 会由 FAIL 变为 PASS、缺陷D1 行是脚本内固定的历史缺陷记录——**不能据此声称重跑复现了旧缺陷**，历史缺陷以 `before-fix/` 中的原始记录为准。

## 独立重跑方式（PowerShell）

前置：本地 MongoDB 运行中（`scripts\start-mongo.bat`，127.0.0.1:27017）；已安装 Node.js 与 mongosh；本机装有 Edge（默认路径 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，不同环境用 `-EdgePath` 覆盖）。

```powershell
cd D:\问卷\docs\evidence\question-bank
npm ci                                    # 仅首次：按 package-lock.json 安装已验证的 puppeteer-core 25.14.0
.\run-acceptance.ps1 -Script after-fix     # 修复后回归（当前代码，应 21 项 PASS）
.\run-acceptance.ps1 -Script before-fix    # 第 15 轮旧脚本在当前代码上的新结果（见上"区别"说明）
```

运行器行为：

- **数据库保护**：`-DbName` 只允许 `survey_system_accept*` 形式的独立验收库（默认 `survey_system_accept`），`survey_system`、`survey_system_test` 等一律拒绝执行；清理只 drop 指定的验收库，且在**启动验收服务之前**执行（服务启动时自动重建全部索引，不出现索引缺失状态）。
- **独立验收服务**：运行器自行以 `MONGODB_DB=<验收库> PORT=3999` 启动 `server/src/app.js`，结束后**只停止它自己启动的这个进程**，不触碰其他服务（正式库服务在 3000 端口不受影响）。
- **结果隔离**：每次运行复制脚本到 `runs\<时间戳>-<before-fix|after-fix>\` 并在该目录执行，截图与 results.json 均落在其中；历史证据目录只读。
- **可覆盖参数**：`-DbName`、`-Port`、`-EdgePath`、`-BaseUrl`、`-NoReset`（不清空验收库）。脚本断言未做任何改动（脚本内仅运行配置支持环境变量覆盖）。

## 第 19 轮变更说明（页内对话框与回归脚本点击方式）

- 题库页的改名/共享/删除/归档等操作原使用浏览器原生 prompt/confirm/alert，部分浏览器环境会拦截原生弹窗（表现为按钮"点了没反应"）。2026-10-26 第 19 轮起改为**页内对话框**（`#dialog-overlay`）。修复后回归（`after-fix`）已按新对话框更新并重跑通过（22 条记录 0 失败）。
- `after-fix/fix-regression.js` 的点击统一改为 `clickEl()`（等待元素后执行 DOM click）：本机 Edge headless 下 puppeteer 的坐标合成点击偶发失效/命中竞态（第 18 轮已记录），DOM click 等效触发同一监听器，**未改变任何测试断言**。
- `before-fix/acceptance.js` 保持历史原样：其在第 19 轮后的代码上重跑时，依赖原生对话框的步骤（8b/8c/8d 等）会超时失败，属预期（脚本针对当时的 UI 编写），历史结果以 `before-fix/acceptance-results.json` 为准。

## 脱敏说明

- 脚本中的账号（`acceptA/acceptB/fixA/fixB`）与密码（`secret123`）是**仅为本地独立验收库设计的测试凭据**，不存在于正式库，不是任何真实凭据。
- 证据中不含真实密码、会话 Cookie、令牌或带凭证的数据库连接串；所有连接均为本机 `127.0.0.1` 无认证的本地开发数据库。
- `results.json` / `acceptance-results.json` 中出现的 `questionId`、`surveyId`、`bankId` 等均为一次性验收库中的临时数据标识。

## 原始位置（.tmp-verify，未删除）

- 修复前：`.tmp-verify/acceptance.js`、`.tmp-verify/acceptance-results.json`、`.tmp-verify/acceptance/`
- 修复后：`.tmp-verify/acceptance-fix/fix-regression.js`、`.tmp-verify/acceptance-fix/results.json`、`.tmp-verify/acceptance-fix/shots/`

## 已实际执行的重跑结果（第 18 轮，runs/ 目录）

| 运行 | 结果 | 说明 |
| --- | --- | --- |
| `after-fix`（2026-10-26 16:20） | **22 条记录、0 失败** | 修复后回归在当前代码上完整通过（含共享界面流程、归档恢复闭环、跨问卷统计界面、控制台干净） |
| `before-fix`（2026-10-26 16:22 与 16:4x，两次一致） | 18 PASS / 2 FAIL / 1 SKIP | **新代码上的新结果，不是旧缺陷复现**：步骤 5b 由历史 FAIL 变为 PASS（D3 已修复）；缺陷D1 行是脚本内固定的历史缺陷记录（非活体检查）；**步骤 4b 出现 FAIL**（见下） |

### 关于 before-fix 重跑中 4b 的已知环境怪癖（与产品无关）

- 现象：版本表单内的 puppeteer 合成点击（`page.click`）在部分时序下不触发监听器——诊断实测 `elementFromPoint` 指向按钮本身、手动 `DOM .click()` 正常加行/提交，合成点击却被吞；4b 的失败表现即该怪癖在"4a 之后再次操作表单"时序下的触发。
- 产品级复核（与 UI 表单分离验证，2026-10-26 实跑）：通过 API 以 `caliberChanged: true` 创建版本 → 201，`caliberLabel` 正确落库；浏览器只读打开版本历史 → 列表正确渲染「新口径A」。**口径功能本身正常，4b 的 FAIL 属验收脚本交互问题，非产品缺陷。**
- 复跑时如 4b 出现 FAIL，请以上述产品级复核为准，勿将其当作口径功能回归。

## 脱敏说明
