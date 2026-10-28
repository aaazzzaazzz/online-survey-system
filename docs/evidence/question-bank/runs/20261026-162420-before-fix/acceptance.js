// 真实浏览器验收：runbook.md §4 第 1–8 步（第 9 步回滚脚本按用户指示不运行，等价场景由 migration.test.js 覆盖）。
// 环境：独立验收库 survey_system_accept + 本机真实 Edge（puppeteer-core，无 mock、无注入）。
// 证据：每步截图保存于 .tmp-verify/acceptance/；结果写 acceptance-results.json；任一步失败以退出码 1 结束。
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// 运行配置可用环境变量覆盖（BASE_URL / EDGE_PATH）；测试断言未做任何改动
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3999';
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOTS = path.join(__dirname, 'acceptance');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const consoleErrors = [];
function record(step, ok, detail, shot) {
  results.push({ step, ok, detail, shot });
  console.log((ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL') + ` [步骤${step}] ${detail}` + (shot ? ` | 截图: acceptance/${path.basename(shot)}` : ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDialog(needle, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const msg = dialogs.length ? dialogs[dialogs.length - 1].message : '';
    if (msg.includes(needle)) return msg;
    await sleep(200);
  }
  return '';
}

let browserA, browserB;
const dialogs = [];
async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(15000);
  page.on('dialog', (d) => {
    dialogs.push({ type: d.type(), message: d.message() });
    d.accept().catch(() => {}); // confirm → 接受；alert/prompt → 关闭（prompt 流程走页面内 fetch）
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name) });

async function waitFor(page, selector, timeout = 10000) {
  await page.waitForSelector(selector, { visible: true, timeout });
}
async function text(page, selector) {
  const el = await page.$(selector);
  return el ? (await el.evaluate((n) => n.textContent)) : '';
}
// 页面内 fetch（同一会话 cookie，真实 HTTP）
async function apiFrom(page, pathName, options = {}) {
  return page.evaluate(async (p, o) => {
    const res = await fetch(p, { method: o.method || 'GET', headers: o.body ? { 'content-type': 'application/json' } : {}, body: o.body ? JSON.stringify(o.body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, pathName, options);
}

async function register(page, username) {
  console.log('  reg: goto');
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  console.log('  reg: waitSelector');
  await page.waitForSelector('#register-form input[name=username]');
  console.log('  reg: type name');
  await page.type('#register-form input[name=username]', username);
  console.log('  reg: type pass');
  await page.type('#register-form input[name=password]', 'secret123');
  console.log('  reg: click submit');
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  await page.click('#register-form button[type=submit]');
  console.log('  reg: nav wait');
  await nav;
  console.log('  reg: done -> ' + page.url());
}

async function main() {
  // 注意：同一浏览器多页签会触发 Edge headless 的后台标签 JS 节流，导致 click 内部
  // evaluate 挂起（已实测复现）。因此 A、B 两个账号各用独立浏览器实例（均单页签）。
  browserA = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 120000 });
  const pageA = await newPage(browserA);
  let pageB = null;
  let bankId, questionId, surveyId, sourceVersionNo;

  try {
    // —— 步骤 1：注册账号 A → 题库入口 ——
    console.log('step1: register A');
    await register(pageA, 'acceptA');
    console.log('step1: registered, goto banks');
    await waitFor(pageA, 'a[href="/banks.html"]');
    await pageA.click('a[href="/banks.html"]');
    await waitFor(pageA, '#my-banks');
    await shot(pageA, '01-题库页入口.png');
    record(1, (await text(pageA, 'h1')).includes('题库管理'), '账号 A 注册登录 → 我的问卷 → 题库管理 → banks.html 正常打开');

    // —— 步骤 2：新建题库 ——
    await pageA.type('#create-bank-form input[name=name]', '验收题库');
    await pageA.type('#create-bank-form textarea[name=description]', '真实浏览器验收用');
    await pageA.click('#create-bank-form button[type=submit]');
    await waitFor(pageA, '.bank-row');
    bankId = await pageA.$eval('.bank-row', (el) => el.dataset.bankId);
    await shot(pageA, '02-题库已创建.png');
    record(2, (await text(pageA, '#my-banks')).includes('验收题库'), '新建题库「验收题库」出现在我的题库列表');

    // —— 步骤 3：新建题目 v1 ——
    await pageA.click('.bank-row button[data-action=open]');
    await waitFor(pageA, '#bank-panel');
    await pageA.click('#toggle-new-question');
    await waitFor(pageA, '#new-question-box:not([hidden])');
    await pageA.select('#q-type', 'single');
    await pageA.type('#question-form input[name=title]', '最喜欢的颜色');
    await pageA.click('#question-form input[name=required]');
    const optRows = await pageA.$$('#q-option-rows .option-label');
    await optRows[0].type('红色');
    await optRows[1].type('蓝色');
    await pageA.click('#q-add-option');
    const optRows2 = await pageA.$$('#q-option-rows .option-label');
    await optRows2[2].type('绿色');
    await pageA.type('#question-form input[name=changeNote]', '初版');
    await pageA.click('#question-form button[type=submit]');
    await pageA.waitForFunction(() => document.querySelector('#bank-questions tbody').textContent.includes('最喜欢的颜色'), { timeout: 10000 });
    await shot(pageA, '03-题目v1已创建.png');
    record(3, true, '单选题 v1 创建成功（3 个选项、必答、版本说明「初版」），出现在题库题目列表');
    const qLink = await pageA.$('#bank-questions tbody a[data-open-question]');
    questionId = await qLink.evaluate((a) => a.dataset.openQuestion);
    await qLink.click();
    await waitFor(pageA, '#question-panel');
    await waitFor(pageA, '#tab-latest:not([hidden])');
    await shot(pageA, '03b-题目详情当前版本.png');

    // —— 步骤 4：版本历史 / 基于此新建 / 口径 / 恢复 ——
    await pageA.click('button[data-tab=versions]');
    await waitFor(pageA, '#tab-versions:not([hidden])');
    await pageA.waitForFunction(() => document.querySelector('#tab-versions').textContent.includes('v1'), { timeout: 10000 });
    // 4a 基于 v1 新建 v2（默认继承口径）
    await pageA.click('button[data-base="1"]');
    await waitFor(pageA, '#version-form-box:not([hidden])');
    await pageA.evaluate(() => { document.getElementById('v-title').value = '最喜欢的颜色（v2）'; });
    await pageA.click('#v-add-option');
    const vRows = await pageA.$$('#v-option-rows .option-label');
    await vRows[3].type('黄色');
    await pageA.type('#version-form input[name=changeNote]', 'v2 增加黄色选项');
    await pageA.click('#version-form button[type=submit]');
    await pageA.waitForFunction(() => document.querySelector('#version-message').textContent.includes('已创建'), { timeout: 10000 });
    await pageA.waitForFunction(() => document.querySelector('#tab-versions').textContent.includes('v2'), { timeout: 10000 });
    await shot(pageA, '04a-版本历史v1v2.png');
    const versionsText = await text(pageA, '#tab-versions');
    record('4a', versionsText.includes('v2') && versionsText.includes('基于 v1'), '基于 v1 创建 v2（增选项），版本历史链路正确（v2 的 parent=v1）');
    // 4b 口径变更声明（v3）
    await pageA.click('button[data-base="1"]');
    await waitFor(pageA, '#version-form-box:not([hidden])');
    await pageA.evaluate(() => { document.getElementById('v-title').value = '颜色（新口径）'; });
    await pageA.evaluate(() => { document.querySelector('#version-form [name=caliberChanged]').checked = true; });
    await pageA.type('#version-form input[name=caliberLabel]', '新口径A');
    await pageA.type('#version-form input[name=changeNote]', '单位改变，声明新口径');
    await pageA.click('#version-form button[type=submit]');
    await pageA.waitForFunction(() => document.querySelector('#tab-versions').textContent.includes('v3'), { timeout: 10000 });
    const v3Text = await text(pageA, '#tab-versions');
    await shot(pageA, '04b-口径声明v3.png');
    record('4b', v3Text.includes('新口径A'), '声明口径改变创建 v3，版本历史显示新口径「新口径A」');
    // 4c 恢复 v1 → 新建记录
    await pageA.click('button[data-restore="1"]');
    await pageA.waitForFunction(() => document.querySelector('#tab-versions').textContent.includes('恢复自 v1'), { timeout: 10000 });
    const restoreText = await text(pageA, '#tab-versions');
    await shot(pageA, '04c-恢复v1.png');
    record('4c', restoreText.includes('v4') && restoreText.includes('恢复自 v1') && restoreText.includes('基于 v1'), '恢复 v1 生成 v4 新记录（parent=v1、说明「恢复自 v1」），历史版本未被覆盖');

    // —— 步骤 5：共享只读（T4）——
    // 先注册 B（共享接口按用户名查用户，被共享者必须已存在），再共享
    browserB = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 120000 });
    pageB = await newPage(browserB);
    await register(pageB, 'acceptB');
    const shareResp = await apiFrom(pageA, `/api/banks/${bankId}/share`, { method: 'POST', body: { username: 'acceptB' } });
    console.log('  share resp: ' + JSON.stringify(shareResp));
    await pageB.goto(BASE + '/banks.html', { waitUntil: 'domcontentloaded' });
    await pageB.waitForFunction(() => document.querySelector('#shared-banks').textContent.includes('验收题库'), { timeout: 10000 });
    await shot(pageB, '05-共享给我的题库.png');
    record('5a', true, 'B 的「共享给我的题库」可见 A 的题库');
    await pageB.click('#shared-banks .bank-row button[data-action=open]');
    await waitFor(pageB, '#bank-panel');
    const viewerMeta = await text(pageB, '#bank-panel-title');
    await shot(pageB, '05b-只读模式.png');
    const writeAttempts = [
      await apiFrom(pageB, `/api/banks/${bankId}`, { method: 'PATCH', body: { name: '篡改' } }),
      await apiFrom(pageB, `/api/banks/${bankId}/questions`, { method: 'POST', body: { type: 'single', title: 'x', required: true, options: ['a', 'b'] } }),
      await apiFrom(pageB, `/api/questions/${questionId}/versions`, { method: 'POST', body: { type: 'single', title: 'x', required: true, options: ['a', 'b'] } }),
      await apiFrom(pageB, `/api/questions/${questionId}`, { method: 'DELETE' }),
    ];
    const statuses = writeAttempts.map((r) => r.status).join(',');
    record('5b', viewerMeta.includes('只读') && statuses === '403,403,403,403', `B 界面标记只读（标题实际=${JSON.stringify(viewerMeta)}）；改名/建题/建版本/删除全部 403（实际 ${statuses}）`);

    // —— 步骤 6：从题库添加（快照固定版本；题库更新/撤共享不影响）——
    await pageA.goto(BASE + '/surveys.html', { waitUntil: 'domcontentloaded' });
    await pageA.type('#create-form input[name=title]', '验收问卷');
    await pageA.click('#create-form button[type=submit]');
    await pageA.waitForFunction(() => [...document.querySelectorAll('#list tbody tr td a.row-title')].some((a) => a.textContent === '验收问卷'), { timeout: 10000 });
    await pageA.click('#list tbody tr a.btn-manage');
    await waitFor(pageA, '#action-from-bank');
    await pageA.click('#action-from-bank');
    await waitFor(pageA, '#from-bank-panel:not([hidden])');
    await pageA.select('#fb-bank', bankId);
    await pageA.waitForFunction(() => document.querySelector('#fb-question').options.length >= 1, { timeout: 10000 });
    await pageA.select('#fb-question', questionId);
    await pageA.waitForFunction(() => document.querySelector('#fb-version').options.length >= 1, { timeout: 10000 });
    // 显式选择 v2（最新版 v4 是恢复自 v1 的三选项版本）。选择器会异步重建选项并回填默认值，
    // 用"设置 → 等待 → 确认生效"轮询，防止被异步重建覆盖。
    let versionSet = false;
    for (let i = 0; i < 10 && !versionSet; i++) {
      await pageA.evaluate(() => { const el = document.getElementById('fb-version'); el.value = '2'; });
      await sleep(400);
      versionSet = (await pageA.$eval('#fb-version', (el) => el.value)) === '2';
    }
    if (!versionSet) throw new Error('版本选择未能固定为 v2');
    await shot(pageA, '06-从题库选择.png');
    await pageA.click('#fb-add');
    await pageA.waitForFunction(() => document.querySelector('#fb-message').textContent.includes('已加入'), { timeout: 10000 });
    await pageA.waitForFunction(() => document.querySelector('#questions').textContent.includes('来自题库'), { timeout: 10000 });
    const surveyUrl = pageA.url();
    surveyId = new URL(surveyUrl).searchParams.get('id');
    const snapText = await text(pageA, '#questions');
    sourceVersionNo = (snapText.match(/来自题库 v(\d+)/) || [])[1];
    await shot(pageA, '06b-快照已加入.png');
    record('6a', snapText.includes('来自题库 v') && snapText.includes('黄色'), `问卷已加入题库题目快照（${sourceVersionNo} 版，含黄色选项，标注来源）`);
    // 题库更新 v5（通过 A 会话的真实 HTTP）：内容大改 → 问卷快照必须不变
    const v5 = await apiFrom(pageA, `/api/questions/${questionId}/versions`, {
      method: 'POST',
      body: { baseVersionNo: 1, type: 'single', title: '颜色（v5）', required: true, options: ['黑', '白'], changeNote: '题库大改' },
    });
    const v5ok = v5.status === 201;
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.waitForFunction(() => document.querySelector('#questions').textContent.includes('最喜欢的颜色'), { timeout: 10000 });
    const afterUpdate = await text(pageA, '#questions');
    await shot(pageA, '06c-题库更新后快照不变.png');
    // 撤销共享
    const bankDetail = await apiFrom(pageA, `/api/banks/${bankId}`);
    const bUid = bankDetail.body.sharedWith.find((s) => s.username === 'acceptB').userId;
    await apiFrom(pageA, `/api/banks/${bankId}/share/${bUid}`, { method: 'DELETE' });
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    const afterUnshare = await text(pageA, '#questions');
    record('6b', v5ok && afterUpdate.includes('黄色') && !afterUpdate.includes('黑') && afterUnshare.includes('黄色') && afterUnshare.includes('来自题库 v' + sourceVersionNo), '题库创建 v5（黑/白）并撤销共享后，问卷快照内容与来源版本完全不变');

    // —— 步骤 7：填写、统计、使用关系、跨问卷统计 ——
    await pageA.click('#publish-btn');
    await pageA.waitForFunction(() => document.querySelector('#fill-link-wrap') && !document.querySelector('#fill-link-wrap').hidden, { timeout: 10000 });
    const fillUrl = await pageA.$eval('#fill-link', (a) => a.href);
    await pageB.goto(fillUrl, { waitUntil: 'domcontentloaded' });
    await waitFor(pageB, '#question-box');
    await pageB.evaluate(() => {
      const labels = [...document.querySelectorAll('#question-box label')];
      const blue = labels.find((l) => l.textContent.includes('蓝色'));
      blue.querySelector('input').click();
    });
    await pageB.click('#next-btn');
    await sleep(300);
    const submitVisible = await pageB.evaluate(() => !document.getElementById('submit-btn').hidden);
    if (submitVisible) await pageB.click('#submit-btn');
    // 等待真实提交结果（#message 元素文本；页面源码里含“提交成功”字样，不能用 body 文本判断）
    await pageB.waitForFunction(() => {
      const m = document.getElementById('message');
      return m && m.textContent.includes('提交成功');
    }, { timeout: 10000 });
    await shot(pageB, '07-填写提交成功.png');
    record('7a', true, 'B 通过分享链接填写并提交成功');
    await pageA.goto(BASE + '/stats.html?id=' + surveyId, { waitUntil: 'domcontentloaded' });
    await pageA.waitForFunction(() => document.body.textContent.includes('蓝色'), { timeout: 10000 });
    const statsText = await text(pageA, 'body');
    await shot(pageA, '07b-问卷统计.png');
    const blueSnippet = (statsText.match(/蓝色[\s\S]{0,60}/) || [])[0];
    record('7b', /蓝色\s*1/.test(statsText.replace(/\s/g, ' ')), `问卷统计显示蓝色选择人数 1（真实答卷聚合）；片段=${JSON.stringify(blueSnippet)}`);
    console.log('step7c: banks -> open -> question -> usages');
    await pageA.goto(BASE + '/banks.html', { waitUntil: 'domcontentloaded' });
    await waitFor(pageA, '#my-banks .bank-row');
    await pageA.click('#my-banks .bank-row button[data-action=open]');
    await waitFor(pageA, '#bank-panel');
    console.log('step7c: wait question in list');
    await pageA.waitForFunction((qid) => document.querySelector(`#bank-questions a[data-open-question="${qid}"]`) !== null, { timeout: 10000 }, questionId);
    console.log('step7c: open question detail');
    await pageA.click(`#bank-questions a[data-open-question="${questionId}"]`);
    await waitFor(pageA, '#question-panel');
    await pageA.click('button[data-tab=usages]');
    await pageA.waitForFunction(() => document.querySelector('#tab-usages').textContent.includes('验收问卷'), { timeout: 10000 });
    const usageText = await text(pageA, '#tab-usages');
    await shot(pageA, '07c-使用关系.png');
    record('7c', usageText.includes('验收问卷') && usageText.includes('v' + sourceVersionNo), '使用关系显示本人问卷（标题可见）与所用版本');
    await pageA.click('button[data-tab=stats]');
    await pageA.waitForFunction(() => document.querySelector('#tab-stats').textContent.includes('蓝色'), { timeout: 10000 });
    const crossText = await text(pageA, '#tab-stats');
    await shot(pageA, '07d-跨问卷统计.png');
    record('7d', crossText.includes('蓝色') && crossText.includes('1 份答卷'), '跨问卷统计按快照口径正确聚合（本人问卷，蓝色 1）');
    // B 的跨问卷统计不得看到 A 的问卷。UI 打开共享题库被缺陷 D3 阻断（已记录），
    // 隐私边界改由 B 浏览器内真实 HTTP 验证（与 UI 同一会话 cookie）
    await apiFrom(pageA, `/api/banks/${bankId}/share`, { method: 'POST', body: { username: 'acceptB' } });
    const bCross = await apiFrom(pageB, `/api/questions/${questionId}/cross-stats`);
    const bOnlyOwn = bCross.status === 200 && Array.isArray(bCross.body.groups) && bCross.body.groups.length === 0;
    record('7e', bOnlyOwn, `B（共享只读）的跨问卷统计不包含 A 的问卷（T1 隐私边界；实际 status=${bCross.status}, groups=${JSON.stringify(bCross.body && bCross.body.groups ? bCross.body.groups.length : null)}）；UI 打开共享题库受缺陷 D3 阻断，未能走界面路径`);

    // —— 步骤 8：归档、取消归档、删除边界 ——
    await pageA.click('button[data-tab=latest]');
    await pageA.click('#action-archive');
    await pageA.waitForFunction(() => !document.querySelector('#bank-questions').textContent.includes('最喜欢的颜色'), { timeout: 10000 });
    await shot(pageA, '08a-归档后列表隐藏.png');
    // 归档后"从题库添加"选择器不可见该题（新建一个草稿问卷验证，已发布的问卷选择器被锁定）
    const draftSurvey = await apiFrom(pageA, '/api/surveys', { method: 'POST', body: { title: '草稿卷', allowAnonymous: false, allowRepeat: false } });
    await pageA.goto(BASE + '/survey.html?id=' + draftSurvey.body.id, { waitUntil: 'domcontentloaded' });
    await pageA.waitForFunction(() => !document.querySelector('#action-from-bank').hidden, { timeout: 10000 });
    await pageA.click('#action-from-bank');
    await waitFor(pageA, '#from-bank-panel:not([hidden])');
    await pageA.select('#fb-bank', bankId);
    await pageA.waitForFunction(() => document.querySelector('#fb-question').options.length >= 0, { timeout: 3000 }).catch(() => {});
    const pickerText = await text(pageA, '#fb-question');
    const hiddenInPicker = !pickerText.includes('最喜欢的颜色');
    await pageA.evaluate(() => { document.getElementById('fb-cancel').click(); });
    record('8a', hiddenInPicker, '归档后题目从题库列表与「从题库添加」选择器消失');
    await pageA.goto(BASE + '/banks.html', { waitUntil: 'domcontentloaded' });
    await waitFor(pageA, '#my-banks .bank-row');
    await pageA.click('#my-banks .bank-row button[data-action=open]');
    await waitFor(pageA, '#bank-panel');
    // 建一个未使用的题目用于删除测试
    await pageA.click('#toggle-new-question');
    await waitFor(pageA, '#new-question-box:not([hidden])');
    await pageA.select('#q-type', 'single');
    await pageA.type('#question-form input[name=title]', '待删除题');
    const rowsD = await pageA.$$('#q-option-rows .option-label');
    await rowsD[0].type('是');
    await rowsD[1].type('否');
    await pageA.click('#question-form button[type=submit]');
    await pageA.waitForFunction(() => document.querySelector('#bank-questions').textContent.includes('待删除题'), { timeout: 10000 });
    // 取消归档：先直接打开归档题目详情（列表隐藏，但可通过接口拿 id 后用 URL？——用取消归档前先归档题未在列表；这里直接对未使用题做删除测试）
    const unusedRow = await pageA.$('#bank-questions a[data-open-question]');
    const unusedQid = await unusedRow.evaluate((a) => a.dataset.openQuestion);
    await unusedRow.click();
    await waitFor(pageA, '#question-panel');
    await pageA.click('#action-delete');
    await pageA.waitForFunction(() => dialogs.length > 0 || true, { timeout: 3000 }).catch(() => {});
    await pageA.waitForFunction(() => document.body.textContent.includes('已删除'), { timeout: 10000 });
    const delMsg = dialogs[dialogs.length - 1] ? dialogs[dialogs.length - 1].message : '';
    await shot(pageA, '08b-未使用题目删除成功.png');
    record('8b', delMsg.includes('已删除'), '未使用题目删除成功（提示「已删除」，版本级联删除）');
    // 缺陷观察 D1：归档题目离开详情页后，列表无任何入口可再打开它，界面无法取消归档
    // （下方 8c 只能通过 API 恢复才能继续走 UI 流程）。复现：归档 → 离开页面 → 返回 → 列表无该题、无「显示已归档」入口。
    record('缺陷D1', false, '归档题目离开详情页后界面无法取消归档（列表隐藏归档题且无筛选/入口，API POST /unarchive 可用但 UI 无入口）。建议：题目列表增加「显示已归档」开关，或将归档题以置灰行显示并保留「取消归档」按钮。');
    // 被使用题目删除 → 409：打开被使用题目详情
    await pageA.goto(BASE + '/banks.html', { waitUntil: 'domcontentloaded' });
    const unarchResp = await pageA.evaluate(async (qid) => {
      // 归档题不在列表，无 UI 入口，只能通过 API 恢复后继续 UI 流程（即缺陷 D1）
      const res = await fetch('/api/questions/' + qid + '/unarchive', { method: 'POST' });
      return { status: res.status, body: await res.json().catch(() => null) };
    }, questionId);
    console.log('  unarchive resp: ' + JSON.stringify(unarchResp) + ' qid=' + questionId);
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(pageA, '#my-banks .bank-row');
    await pageA.click('#my-banks .bank-row button[data-action=open]');
    await waitFor(pageA, '#bank-panel');
    await sleep(800);
    console.log('  8c dump title=' + JSON.stringify(await text(pageA, '#bank-panel-title')));
    console.log('  8c dump ids=' + JSON.stringify(await pageA.evaluate(() => [...document.querySelectorAll('#bank-questions a[data-open-question]')].map((a) => a.dataset.openQuestion))));
    console.log('  8c expect id=' + JSON.stringify(questionId));
    {
      let found = false;
      for (let i = 0; i < 20 && !found; i++) {
        found = await pageA.evaluate((qid) => [...document.querySelectorAll('#bank-questions a[data-open-question]')].some((a) => a.dataset.openQuestion === qid), questionId);
        if (!found) await sleep(500);
      }
      if (!found) throw new Error('8c 找不到被使用题目入口');
    }
    await shot(pageA, '08c-取消归档后恢复.png');
    await pageA.evaluate((qid) => [...document.querySelectorAll('#bank-questions a[data-open-question]')].find((a) => a.dataset.openQuestion === qid).click(), questionId);
    await waitFor(pageA, '#question-panel');
    await pageA.click('#action-delete');
    const usedDelMsg = await waitDialog('不能删除');
    await shot(pageA, '08d-被使用题目删除409.png');
    record('8c', usedDelMsg.includes('不能删除'), '被问卷使用的题目删除被拒（提示「不能删除」409，T5）');
    // 非空题库删除 → 409
    await pageA.goto(BASE + '/banks.html', { waitUntil: 'domcontentloaded' });
    await pageA.waitForSelector('.bank-row[data-kind=mine]');
    await pageA.click('.bank-row[data-kind=mine] button[data-action=delete]');
    const bankDelMsg = await waitDialog('不能删除');
    await shot(pageA, '08e-非空题库删除409.png');
    record('8d', bankDelMsg.includes('不能删除'), '非空题库删除被拒（409）');

    record(9, null, '第 9 步（回滚脚本）按用户指示不运行；等价场景（删除三个新集合后现有功能与快照问卷不受影响）已由 migration.test.js 自动化覆盖');
  } catch (err) {
    record('异常', false, '验收中断：' + String(err && err.message ? err.message : err));
    await shot(pageA, '99-异常现场.png').catch(() => {});
  } finally {
    fs.writeFileSync(path.join(__dirname, 'acceptance-results.json'), JSON.stringify({ results, consoleErrors, at: new Date().toISOString() }, null, 2));
    if (browserA) await browserA.close().catch(() => {});
    if (browserB) await browserB.close().catch(() => {});
  }
  const failed = results.filter((r) => r.ok === false);
  console.log(`\n共 ${results.length} 条记录；失败 ${failed.length} 条；浏览器 console 错误 ${consoleErrors.length} 条`);
  if (consoleErrors.length) console.log('console 错误：' + JSON.stringify(consoleErrors, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
