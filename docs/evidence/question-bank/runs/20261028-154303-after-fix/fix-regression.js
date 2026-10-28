// D3/D1/D2 修复回归（第 16 轮）：真实 Edge + 独立验收库 survey_system_accept。
// 覆盖：1) 共享题库完整界面流程（B 点击打开→查看题目与版本→从题库选题→发布填写提交→看统计）；
//       2) 只读权限（B 界面无写入口 + 直接调用写接口仍 403，两类验证分开记录）；
//       3) 归档恢复闭环（归档→离开→刷新→显示已归档→打开→取消归档→列表与选题入口恢复，快照/版本/答卷不变）；
//       4) B 的跨问卷统计界面路径（此前被 D3 阻断）且不包含 A 的问卷；
//       5) 控制台无 undefined.name / scrollIntoView 异常。
// 证据目录：.tmp-verify/acceptance-fix/shots/ 与 results.json（不覆盖第 15 轮 acceptance/ 目录）。
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// 运行配置可用环境变量覆盖（BASE_URL / EDGE_PATH）；测试断言未做任何改动
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3999';
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const consoleErrors = { A: [], B: [] };
const pageErrors = { A: [], B: [] };
function record(step, ok, detail, shot) {
  results.push({ step, ok, detail, shot });
  console.log((ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL') + ` [${step}] ${detail}` + (shot ? ` | 截图: shots/${path.basename(shot)}` : ''));
}
// 稳定点击：本机 Edge headless 下 puppeteer 的坐标合成点击偶发失效/命中竞态（第 18 轮已记录），
// 统一改为等待元素后执行 DOM click（等效触发同一监听器；不改变任何测试断言）。
async function clickEl(page, selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 15000 });
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('找不到元素: ' + sel);
    el.click();
  }, selector);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browserA, browserB;
const dialogs = { A: [], B: [] };
async function newPage(browser, who) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(15000);
  page.on('dialog', (d) => { dialogs[who].push({ type: d.type(), message: d.message() }); d.accept().catch(() => {}); });
  page.on('pageerror', (err) => pageErrors[who].push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors[who].push(msg.text()); });
  return page;
}
async function waitDialog(who, needle, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const msg = dialogs[who].length ? dialogs[who][dialogs[who].length - 1].message : '';
    if (msg.includes(needle)) return msg;
    await sleep(200);
  }
  return '';
}
const shot = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name) }); return name; };
async function waitFor(page, selector, timeout = 10000) {
  await page.waitForSelector(selector, { visible: true, timeout });
}
async function text(page, selector) {
  const el = await page.$(selector);
  return el ? await el.evaluate((n) => n.textContent) : '';
}
async function apiFrom(page, pathName, options = {}) {
  return page.evaluate(async (p, o) => {
    const res = await fetch(p, { method: o.method || 'GET', headers: o.body ? { 'content-type': 'application/json' } : {}, body: o.body ? JSON.stringify(o.body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, pathName, options);
}
async function register(page, username) {
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#register-form input[name=username]');
  await page.type('#register-form input[name=username]', username);
  await page.type('#register-form input[name=password]', 'secret123');
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  await clickEl(page, '#register-form button[type=submit]');
  await nav;
}

async function main() {
  browserA = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 120000 });
  browserB = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 120000 });
  const pageA = await newPage(browserA, 'A');
  const pageB = await newPage(browserB, 'B');
  let bankId, questionId;

  try {
    // ================= 准备：A 建题库/题目/版本，B 注册，A 共享 =================
    await register(pageA, 'fixA');
    await register(pageB, 'fixB');
    await pageA.goto(BASE + '/banks.html', { waitUntil: 'domcontentloaded' });
    await waitFor(pageA, '#create-bank-form input[name=name]');
    await pageA.type('#create-bank-form input[name=name]', '回归题库');
    await clickEl(pageA, '#create-bank-form button[type=submit]');
    await waitFor(pageA, '.bank-row');
    bankId = await pageA.$eval('.bank-row', (el) => el.dataset.bankId);
    await clickEl(pageA, '.bank-row button[data-action=open]');
    await waitFor(pageA, '#bank-panel');
    await clickEl(pageA, '#toggle-new-question');
    await waitFor(pageA, '#new-question-box:not([hidden])');
    await pageA.select('#q-type', 'single');
    await pageA.type('#question-form input[name=title]', '颜色');
    const opts = await pageA.$$('#q-option-rows .option-label');
    await opts[0].type('红');
    await opts[1].type('蓝');
    await clickEl(pageA, '#q-add-option');
    const opts2 = await pageA.$$('#q-option-rows .option-label');
    await opts2[2].type('绿');
    await clickEl(pageA, '#question-form button[type=submit]');
    await pageA.waitForFunction(() => document.querySelector('#bank-questions tbody').textContent.includes('颜色'), { timeout: 10000 });
    questionId = await pageA.$eval('#bank-questions tbody a[data-open-question]', (a) => a.dataset.openQuestion);
    // v2（加黄色选项）
    await clickEl(pageA, '#bank-questions a[data-open-question]');
    await waitFor(pageA, '#question-panel');
    await clickEl(pageA, 'button[data-tab=versions]');
    await pageA.waitForFunction(() => document.querySelector('#tab-versions').textContent.includes('v1'), { timeout: 10000 });
    await clickEl(pageA, 'button[data-base="1"]');
    await waitFor(pageA, '#version-form-box:not([hidden])');
    await clickEl(pageA, '#v-add-option');
    const vOpts = await pageA.$$('#v-option-rows .option-label');
    await vOpts[3].type('黄');
    await pageA.type('#version-form input[name=changeNote]', 'v2 增加黄色');
    await clickEl(pageA, '#version-form button[type=submit]');
    await pageA.waitForFunction(() => document.querySelector('#version-message').textContent.includes('已创建'), { timeout: 10000 });
    await pageA.waitForFunction(() => document.querySelector('#tab-versions').textContent.includes('v2'), { timeout: 10000 });
    record('准备', true, `A 建题库/题目 v1/v2 完成（bank=${bankId}）`);
    const shareResp = await apiFrom(pageA, `/api/banks/${bankId}/share`, { method: 'POST', body: { username: 'fixB' } });
    record('准备-共享', shareResp.status === 200, `A 共享给 fixB（status=${shareResp.status}）`);

    // A 提前建立使用 v1 的问卷并提交答卷（回归 4 的隐私断言对象，也是回归 3 的历史数据检查对象）
    const aSurvey = await apiFrom(pageA, '/api/surveys', { method: 'POST', body: { title: 'A的快照卷', allowAnonymous: false, allowRepeat: true } });
    await apiFrom(pageA, `/api/surveys/${aSurvey.body.id}/questions/from-bank`, { method: 'POST', body: { bankQuestionId: questionId, versionNo: 1 } });
    await apiFrom(pageA, `/api/surveys/${aSurvey.body.id}/publish`, { method: 'POST' });
    const aDetail = await apiFrom(pageA, `/api/surveys/${aSurvey.body.id}`);
    const qidA = aDetail.body.questions[0].id;
    const redOpt = aDetail.body.questions[0].options.find((o) => o.label === '红').id;
    await apiFrom(pageA, `/api/fill/${aSurvey.body.id}/submit`, { method: 'POST', body: { answers: [{ questionId: qidA, value: redOpt }] } });
    const snapshotBefore = JSON.stringify(aDetail.body.questions);
    const versionsBefore = JSON.stringify((await apiFrom(pageA, `/api/questions/${questionId}/versions`)).body);
    record('准备-A快照卷', true, 'A 建立使用 v1 的快照卷并提交 1 份答卷（红色）');

    // ================= 回归 1+2：B 界面打开共享题库（D3 路径）与只读边界 =================
    await pageB.goto(BASE + '/banks.html', { waitUntil: 'domcontentloaded' });
    await pageB.waitForFunction(() => document.querySelector('#shared-banks').textContent.includes('回归题库'), { timeout: 10000 });
    await clickEl(pageB, '#shared-banks .bank-row button[data-action=open]'); // D3 原故障点
    await waitFor(pageB, '#bank-panel');
    await sleep(500);
    const bPanelTitle = await text(pageB, '#bank-panel-title');
    record('1a-D3打开', bPanelTitle.includes('回归题库') && bPanelTitle.includes('只读'), `B 点击「打开」后面板标题正确（实际=${JSON.stringify(bPanelTitle)}）`, await shot(pageB, '1a-B打开共享题库.png'));
    await pageB.waitForFunction(() => document.querySelector('#bank-questions').textContent.includes('颜色'), { timeout: 10000 });
    record('1b-题目列表', true, 'B 能看到共享题库的题目列表');
    await clickEl(pageB, '#bank-questions a[data-open-question]');
    await waitFor(pageB, '#question-panel');
    await clickEl(pageB, 'button[data-tab=versions]');
    await pageB.waitForFunction(() => document.querySelector('#tab-versions').textContent.includes('v2'), { timeout: 10000 });
    const bVersions = await text(pageB, '#tab-versions');
    const bWriteButtons = await pageB.evaluate(() => document.querySelectorAll('#tab-versions button[data-base], #tab-versions button[data-restore]').length);
    record('1c-版本查看', bVersions.includes('v1') && bVersions.includes('v2') && bWriteButtons === 0, `B 可查看 v1/v2；版本列表无「基于此新建/恢复」按钮（实际按钮数=${bWriteButtons}）`, await shot(pageB, '1c-B查看版本只读.png'));
    // 只读界面：写入口全部隐藏
    const uiHidden = await pageB.evaluate(() => ({
      newQuestion: document.getElementById('toggle-new-question').hidden,
      fromSurvey: document.getElementById('toggle-from-survey').hidden,
      renameBtn: [...document.querySelectorAll('#shared-banks .bank-row button')].some((b) => b.textContent.includes('改名')),
      shareBtn: [...document.querySelectorAll('#shared-banks .bank-row button')].some((b) => b.textContent.includes('共享')),
      deleteBtn: [...document.querySelectorAll('#shared-banks .bank-row button')].some((b) => b.textContent.includes('删除')),
    }));
    record('2a-界面无写入口', uiHidden.newQuestion && uiHidden.fromSurvey && !uiHidden.renameBtn && !uiHidden.shareBtn && !uiHidden.deleteBtn, `B 界面隐藏新建/存入/改名/共享/删除入口（实际=${JSON.stringify(uiHidden)}）`);
    // 只读权限：直接调用写接口仍被拒绝（HTTP 权限验证，与界面验证分开记录）
    const writes = [
      await apiFrom(pageB, `/api/banks/${bankId}`, { method: 'PATCH', body: { name: '篡改' } }),
      await apiFrom(pageB, `/api/banks/${bankId}/questions`, { method: 'POST', body: { type: 'single', title: 'x', required: true, options: ['a', 'b'] } }),
      await apiFrom(pageB, `/api/questions/${questionId}/versions`, { method: 'POST', body: { type: 'single', title: 'x', required: true, options: ['a', 'b'] } }),
      await apiFrom(pageB, `/api/questions/${questionId}/versions/1/restore`, { method: 'POST', body: {} }),
      await apiFrom(pageB, `/api/questions/${questionId}/archive`, { method: 'POST' }),
      await apiFrom(pageB, `/api/questions/${questionId}`, { method: 'DELETE' }),
    ];
    const statuses = writes.map((w) => w.status).join(',');
    record('2b-HTTP写接口拒绝', statuses === '403,403,403,403,403,403', `B 直接调用 6 类写接口全部 403（实际 ${statuses}）`);

    // ================= 回归 1：B 从题库选题（指定 v2）→ 发布填写提交 → 看统计 =================
    const bSurvey = await apiFrom(pageB, '/api/surveys', { method: 'POST', body: { title: 'B的回归卷', allowAnonymous: false, allowRepeat: false } });
    await pageB.goto(BASE + '/survey.html?id=' + bSurvey.body.id, { waitUntil: 'domcontentloaded' });
    await pageB.waitForFunction(() => !document.getElementById('action-from-bank').hidden, { timeout: 10000 });
    await clickEl(pageB, '#action-from-bank');
    await waitFor(pageB, '#from-bank-panel:not([hidden])');
    await pageB.select('#fb-bank', bankId);
    await pageB.waitForFunction(() => document.querySelector('#fb-question').options.length >= 1, { timeout: 10000 });
    await pageB.select('#fb-question', questionId);
    await pageB.waitForFunction(() => document.querySelector('#fb-version').options.length >= 1, { timeout: 10000 });
    let versionSet = false;
    for (let i = 0; i < 10 && !versionSet; i++) {
      await pageB.evaluate(() => { const el = document.getElementById('fb-version'); el.value = '2'; });
      await sleep(400);
      versionSet = (await pageB.$eval('#fb-version', (el) => el.value)) === '2';
    }
    if (!versionSet) throw new Error('版本选择未能固定为 v2');
    await shot(pageB, '1d-B从题库选v2.png');
    await clickEl(pageB, '#fb-add');
    await pageB.waitForFunction(() => document.getElementById('fb-message').textContent.includes('已加入'), { timeout: 10000 });
    await pageB.waitForFunction(() => document.getElementById('questions').textContent.includes('来自题库 v2'), { timeout: 10000 });
    const bSnapText = await text(pageB, '#questions');
    record('1d-快照v2', bSnapText.includes('来自题库 v2') && bSnapText.includes('黄'), 'B 通过界面把 v2 加入自己的草稿问卷（含黄色选项、来源标记 v2）', await shot(pageB, '1d-快照已加入.png'));
    await clickEl(pageB, '#publish-btn');
    await pageB.waitForFunction(() => document.getElementById('fill-link-wrap') && !document.getElementById('fill-link-wrap').hidden, { timeout: 10000 });
    const fillUrl = await pageB.$eval('#fill-link', (a) => a.href);
    await pageB.goto(fillUrl, { waitUntil: 'domcontentloaded' });
    await waitFor(pageB, '#question-box');
    await pageB.evaluate(() => {
      const labels = [...document.querySelectorAll('#question-box label')];
      const yellow = labels.find((l) => l.textContent.includes('黄'));
      yellow.querySelector('input').click();
    });
    await clickEl(pageB, '#next-btn');
    await sleep(300);
    if (await pageB.evaluate(() => !document.getElementById('submit-btn').hidden)) await clickEl(pageB, '#submit-btn');
    await pageB.waitForFunction(() => { const m = document.getElementById('message'); return m && m.textContent.includes('提交成功'); }, { timeout: 10000 });
    record('1e-填写提交', true, 'B 填写（黄色）并提交成功');
    await pageB.goto(BASE + '/stats.html?id=' + bSurvey.body.id, { waitUntil: 'domcontentloaded' });
    await pageB.waitForFunction(() => document.body.textContent.includes('黄色') || document.body.textContent.includes('黄'), { timeout: 10000 });
    const bStats = (await text(pageB, 'body')).replace(/\s/g, ' ');
    record('1f-本人统计', /黄\s*1/.test(bStats), 'B 查看自己问卷统计：黄色=1', await shot(pageB, '1f-B自己的统计.png'));

    // ================= 回归 4：B 的跨问卷统计界面路径（原被 D3 阻断） =================
    await pageB.goto(BASE + '/banks.html', { waitUntil: 'domcontentloaded' });
    await pageB.waitForFunction(() => document.querySelector('#shared-banks').textContent.includes('回归题库'), { timeout: 10000 });
    await clickEl(pageB, '#shared-banks .bank-row button[data-action=open]');
    await waitFor(pageB, '#bank-panel');
    await pageB.waitForFunction(() => document.querySelector('#bank-questions').textContent.includes('颜色'), { timeout: 10000 });
    await clickEl(pageB, '#bank-questions a[data-open-question]');
    await waitFor(pageB, '#question-panel');
    await clickEl(pageB, 'button[data-tab=stats]');
    await pageB.waitForFunction(() => document.querySelector('#tab-stats').textContent.includes('份问卷') || document.querySelector('#tab-stats').textContent.includes('你的问卷'), { timeout: 10000 });
    const bCross = await text(pageB, '#tab-stats');
    record('4-B界面跨问卷统计', bCross.includes('B的回归卷') && !bCross.includes('快照卷') && !bCross.includes('A的'), `B 通过界面打开跨问卷统计：含自己的问卷、不含 A 的问卷（实际片段=${JSON.stringify(bCross.slice(0, 120))}）`, await shot(pageB, '4-B跨问卷统计界面.png'));

    // ================= 回归 3：A 归档恢复闭环（含快照/版本/答卷不变） =================
    // 归档 → 离开 → 重新进入（刷新）→ 显示已归档 → 打开 → 取消归档
    await pageA.goto(BASE + '/banks.html', { waitUntil: 'domcontentloaded' });
    await waitFor(pageA, '#my-banks .bank-row');
    await clickEl(pageA, '#my-banks .bank-row button[data-action=open]');
    await waitFor(pageA, '#bank-panel');
    await pageA.waitForFunction(() => document.querySelector('#bank-questions').textContent.includes('颜色'), { timeout: 10000 });
    await clickEl(pageA, '#bank-questions a[data-open-question]');
    await waitFor(pageA, '#question-panel');
    await clickEl(pageA, '#action-archive');
    // 页内确认对话框（第 19 轮起替代原生 confirm；部分浏览器会拦截原生弹窗）
    await pageA.waitForFunction(() => !document.getElementById('dialog-overlay').hidden && document.getElementById('dialog-message').textContent.includes('归档'), { timeout: 10000 });
    await clickEl(pageA, '#dialog-ok');
    await pageA.waitForFunction(() => document.getElementById('action-unarchive').hidden === false, { timeout: 10000 });
    record('3a-归档', true, 'A 归档题目（页内确认对话框）');
    // 离开并重新进入（全新页面加载）
    await pageA.goto(BASE + '/surveys.html', { waitUntil: 'domcontentloaded' });
    await pageA.goto(BASE + '/banks.html', { waitUntil: 'domcontentloaded' });
    await waitFor(pageA, '#my-banks .bank-row');
    await clickEl(pageA, '#my-banks .bank-row button[data-action=open]');
    await waitFor(pageA, '#bank-panel');
    await sleep(500);
    const normalList = await text(pageA, '#bank-questions');
    record('3b-默认隐藏', !normalList.includes('颜色'), '重新进入后默认列表不显示归档题');
    await clickEl(pageA, '#show-archived');
    await pageA.waitForFunction(() => document.querySelector('#bank-questions').textContent.includes('颜色'), { timeout: 10000 });
    const archivedRow = await text(pageA, '#bank-questions');
    record('3c-显示已归档', archivedRow.includes('已归档'), '勾选「显示已归档」后可见归档题并带「已归档」标识', await shot(pageA, '3c-显示已归档列表.png'));
    await clickEl(pageA, '#bank-questions a[data-open-question]');
    await waitFor(pageA, '#question-panel');
    // 详情异步加载完成后「取消归档」按钮才出现，等待其可见再断言
    await pageA.waitForFunction(() => document.getElementById('action-unarchive').hidden === false, { timeout: 10000 });
    record('3d-可打开详情', true, '归档题详情可打开，出现「取消归档」按钮');
    await clickEl(pageA, '#action-unarchive');
    await pageA.waitForFunction(() => document.getElementById('action-unarchive').hidden, { timeout: 10000 });
    record('3e-取消归档', true, '取消归档成功');
    // 关闭开关 → 正常列表恢复
    await clickEl(pageA, '#show-archived');
    await sleep(500);
    const normalAfter = await text(pageA, '#bank-questions');
    record('3f-正常列表恢复', normalAfter.includes('颜色') && !normalAfter.includes('已归档'), '取消归档后题目回到正常列表', await shot(pageA, '3f-取消归档后正常列表.png'));
    // 选题入口恢复（A 的草稿问卷打开选择器）
    const draft = await apiFrom(pageA, '/api/surveys', { method: 'POST', body: { title: '选题入口检查', allowAnonymous: false, allowRepeat: false } });
    await pageA.goto(BASE + '/survey.html?id=' + draft.body.id, { waitUntil: 'domcontentloaded' });
    await pageA.waitForFunction(() => !document.getElementById('action-from-bank').hidden, { timeout: 10000 });
    await clickEl(pageA, '#action-from-bank');
    await waitFor(pageA, '#from-bank-panel:not([hidden])');
    await pageA.select('#fb-bank', bankId);
    await pageA.waitForFunction(() => document.querySelector('#fb-question').options.length >= 1, { timeout: 10000 });
    const pickerText = await text(pageA, '#fb-question');
    record('3g-选题入口恢复', pickerText.includes('颜色'), '取消归档后「从题库添加」选择器恢复该题', await shot(pageA, '3g-选题入口恢复.png'));
    // 历史快照/版本/答卷不变
    const aDetailAfter = await apiFrom(pageA, `/api/surveys/${aSurvey.body.id}`);
    const versionsAfter = JSON.stringify((await apiFrom(pageA, `/api/questions/${questionId}/versions`)).body);
    const snapshotSame = JSON.stringify(aDetailAfter.body.questions) === snapshotBefore;
    const versionsSame = versionsAfter === versionsBefore;
    const statsA = await apiFrom(pageA, `/api/stats/${aSurvey.body.id}`);
    const respSame = statsA.body.questions[0].optionCounts.find((o) => o.label === '红').count === 1;
    record('3h-历史数据不变', snapshotSame && versionsSame && respSame, `归档/取消归档全程：问卷快照、版本链、历史答卷统计不变（snapshot=${snapshotSame} versions=${versionsSame} 红=${respSame ? 1 : '?'}）`);

    // ================= 回归 5：控制台与异常 =================
    const badA = pageErrors.A.concat(consoleErrors.A);
    const badB = pageErrors.B.concat(consoleErrors.B);
    const d2Sig = badA.concat(badB).filter((e) => /scrollIntoView is not a function/.test(e));
    const d3Sig = badA.concat(badB).filter((e) => /undefined/.test(e) && /name/.test(e));
    const pageErr = pageErrors.A.concat(pageErrors.B).filter((e) => !/Failed to load resource/.test(e));
    // 预期内的 403/404/401 网络日志不计入异常（负向 HTTP 权限验证产生）
    const unexpectedConsole = badA.concat(badB).filter((e) => !/Failed to load resource/.test(e));
    record('5-控制台干净', d2Sig.length === 0 && d3Sig.length === 0 && pageErr.length === 0 && unexpectedConsole.length === 0,
      `无 scrollIntoView 异常（${d2Sig.length} 条）、无 undefined.name 异常（${d3Sig.length} 条）、无未处理页面异常（${pageErr.length} 条）、无非资源类控制台错误（${unexpectedConsole.length} 条）；预期 401/403/404 网络日志单独记录：` +
      JSON.stringify([...new Set(badA.concat(badB).filter((e) => /Failed to load resource/.test(e)).map((e) => (e.match(/status of (\d+)/) || [])[1]))]));

    record('终', null, '回归完成：1 共享完整界面流程 / 2 只读权限（界面+HTTP）/ 3 归档恢复闭环 / 4 B 界面跨问卷统计 / 5 控制台');
  } catch (err) {
    record('异常', false, '回归中断：' + String(err && err.message ? err.message : err));
    await shot(pageA, '99-异常现场.png').catch(() => {});
  } finally {
    fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({ results, pageErrors, consoleErrors, at: new Date().toISOString() }, null, 2));
    await browserA.close().catch(() => {});
    await browserB.close().catch(() => {});
  }
  const failed = results.filter((r) => r.ok === false);
  console.log(`\n共 ${results.length} 条记录；失败 ${failed.length} 条`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
