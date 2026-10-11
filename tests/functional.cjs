'use strict';

const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8787/';
const EDGE_PATH = process.env.EDGE_PATH || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);
const STORAGE_KEY = 'liuyibi-budget-v1';
const FIXED_TIME = new Date('2026-10-11T10:00:00+08:00');
const FIXED_DAY = '2026-10-11';

function money(cents) {
  return `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function readState(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
}

async function clickAndWaitHidden(page, selector, submitSelector) {
  await page.locator(submitSelector).click();
  await page.locator(selector).waitFor({ state: 'hidden' });
}

async function confirmDialog(page) {
  await page.locator('#confirmModal.open').waitFor();
  await page.locator('#confirmAccept').click();
  await page.locator('#confirmModal').waitFor({ state: 'hidden' });
}

async function setSalary(page, amount) {
  await page.locator('[data-page="settingsPage"]').click();
  await page.locator('#salaryInput').fill(String(amount));
  await page.locator('#salaryForm button[type="submit"]').click();
}

async function createFund(page, { name, type = 'fixed', allowance = 0, contribution = 0, opening = 0 }) {
  await page.locator('[data-page="walletsPage"]').click();
  await page.locator('#addWalletBtn').click();
  await page.locator('#fundName').fill(name);
  await page.locator('#fundType').selectOption(type);
  if (type === 'fixed') await page.locator('#fundAllowance').fill(String(allowance));
  if (type === 'increment') {
    await page.locator('#fundIncrement').fill(String(contribution));
    await page.locator('#fundOpening').fill(String(opening));
  }
  if (type === 'stored') await page.locator('#fundStoredBalance').fill(String(opening));
  await clickAndWaitHidden(page, '#fundModal', '#fundForm button[type="submit"]');
  const state = await readState(page);
  const fund = state.funds.find(item => item.name === name);
  assert.ok(fund, `钱包“${name}”应已通过表单创建`);
  return fund;
}

async function loadLegacySavingsWallet(page) {
  const state = await readState(page);
  const fund = {
    id: 'legacy-savings-fixture', name: '功能测试旧版长期储蓄', type: 'savings',
    allowanceCents: 0, contributionCents: 0, openingCents: 0,
    createdAt: FIXED_TIME.getTime(), color: '#9179a9', disabledAt: null
  };
  state.funds.push(fund);
  const cycle = state.cycles.find(item => item.endAt == null);
  assert.ok(cycle, '旧钱包 fixture 需要当前发薪周期');
  const oldSnapshot = { type: 'savings', amountCents: 0 };
  cycle.allocations[fund.id] = oldSnapshot;
  state.entries.push({
    id: 'legacy-savings-opening-fixture', fundId: fund.id, fundName: fund.name,
    kind: 'opening', date: FIXED_DAY, timestamp: FIXED_TIME.getTime(),
    amountCents: 10000, note: '旧版长期储蓄初始余额'
  });
  const oldEntryId = state.entries.at(-1).id;
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: STORAGE_KEY,
    value: JSON.stringify(state)
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#fundGrid').waitFor();
  const loaded = await page.evaluate(() => JSON.parse(JSON.stringify(state)));
  assert.equal(loaded.funds.find(item => item.id === fund.id)?.type, 'increment', '重载应把旧版长期储蓄规范为长期储蓄钱包');
  assert.equal(loaded.funds.find(item => item.id === fund.id)?.contributionCents, 0, '规范化的旧钱包不应意外设置自动存入金额');
  assert.deepEqual(loaded.cycles.find(item => item.id === cycle.id).allocations[fund.id], oldSnapshot, '规范化不得改写旧周期快照');
  assert.ok(loaded.entries.some(item => item.id === oldEntryId), '规范化不得重写或删除原钱包流水');
  assert.equal(await readWalletBalanceCents(page, fund.id), 10000, '旧版长期储蓄钱包应按原流水保留余额');
  await page.locator(`[data-edit-fund="${fund.id}"]`).click();
  assert.equal(await page.locator('#fundType').inputValue(), 'increment', '编辑旧版长期储蓄时应显示统一类型');
  assert.equal(await page.locator('#fundType').isDisabled(), true, '既有钱包类型仍不可更换');
  assert.equal(await page.locator('#fundIncrement').inputValue(), '0.00', '旧钱包编辑时自动存入应为 0');
  await clickAndWaitHidden(page, '#fundModal', '#fundForm button[type="submit"]');
  const persisted = await readState(page);
  assert.equal(persisted.funds.find(item => item.id === fund.id)?.type, 'increment', '保存后旧钱包规范化类型应持久化');
  assert.deepEqual(persisted.cycles.find(item => item.id === cycle.id).allocations[fund.id], oldSnapshot, '保存不得改写旧周期快照');
  return fund;
}

async function clickWalletMoreAction(page, selector) {
  const button = page.locator(selector);
  if (!await button.isVisible()) {
    const card = button.locator('xpath=ancestor::article[1]');
    await card.locator('details.wallet-more > summary').click();
  }
  await button.scrollIntoViewIfNeeded();
  const cardBox = await button.locator('xpath=ancestor::article[1]').boundingBox();
  const buttonBox = await button.boundingBox();
  assert.ok(cardBox && buttonBox, '更多操作应在卡片中可见');
  assert.ok(buttonBox.y >= cardBox.y && buttonBox.y + buttonBox.height <= cardBox.y + cardBox.height,
    '展开的更多操作必须位于钱包卡片边界内');
  await button.click();
}

async function readWalletBalanceCents(page, fundId) {
  const text = (await page.locator(`[data-wallet-id="${fundId}"], [data-wallet-detail="${fundId}"]`).first().locator('.wallet-balance strong').textContent()).trim();
  return Math.round(Number(text.replace(/[¥,]/g, '')) * 100);
}

async function createRule(page, fundId, { name, frequency = 'once', amount = '5.00', due = FIXED_DAY, hour = '9' }) {
  await page.locator(`[data-wallet-detail="${fundId}"]`).click();
  await page.locator('#addRuleBtn').click();
  await page.locator('#ruleName').fill(name);
  await page.locator('#ruleFrequency').selectOption(frequency);
  await page.locator('#ruleAmount').fill(amount);
  await page.locator('#ruleFirstDue').fill(due);
  await page.locator('#ruleHour').fill(hour);
  await page.locator('#ruleForm button[type="submit"]').click();
  if (await page.locator('#confirmModal').evaluate(node => node.classList.contains('open'))) await confirmDialog(page);
  await page.locator('#ruleModal').waitFor({ state: 'hidden' });
  await page.locator('#detailModal [data-close="detailModal"]').click();
  const state = await readState(page);
  const rule = state.rules.find(item => item.name === name);
  assert.ok(rule, `规则“${name}”应已保存`);
  return rule;
}

async function createBrowserPage(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    timezoneId: 'Asia/Shanghai',
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await page.clock.install({ time: FIXED_TIME });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#fundGrid').waitFor();
  return { context, page, pageErrors };
}

const cases = [
  {
    name: '钱包创建、临时收入、长期储蓄和账户互转、记账持久化与工资上限',
    async run(page) {
      await setSalary(page, '5000.00');
      await page.locator('[data-page="walletsPage"]').click();
      await page.locator('#addWalletBtn').click();
      const fundTypes = await page.locator('#fundType option').evaluateAll(options => options.map(option => option.value));
      assert.deepEqual(fundTypes, ['fixed', 'increment', 'stored'], '新建钱包仅提供周期定额、长期储蓄和会员储值');
      await page.locator('#fundModal button.close-button').click();
      const source = await createFund(page, { name: '功能测试临时钱包', allowance: '300.00' });
      const target = await createFund(page, { name: '功能测试接收钱包', allowance: '100.00' });
      const increment = await createFund(page, { name: '功能测试长期储蓄目标', type: 'increment', contribution: '50.00', opening: '10.00' });
      const savings = await loadLegacySavingsWallet(page);

      await clickWalletMoreAction(page, `[data-extra-deposit="${source.id}"]`);
      assert.equal(await page.locator('#extraDepositFund').inputValue(), source.id, '临时收入表单应选择触发操作的钱包');
      assert.ok(await page.locator(`#extraDepositFund option[value="${source.id}"]`).count(), '临时收入表单必须提供有效的钱包选项');
      await page.locator('#extraDepositAmount').fill('25.00');
      await page.locator('#extraDepositNote').fill('回归临时收入');
      await clickAndWaitHidden(page, '#extraDepositModal', '#extraDepositForm button[type="submit"]');

      await clickWalletMoreAction(page, `[data-balance-transfer="fund:${source.id}"]`);
      await page.locator('#transferTarget').selectOption(target.id);
      await page.locator('#transferAmount').fill('40.00');
      await clickAndWaitHidden(page, '#transferModal', '#transferForm button[type="submit"]');

      await clickWalletMoreAction(page, `[data-extra-deposit="${savings.id}"]`);
      assert.equal(await page.locator('#extraDepositFund').inputValue(), savings.id, '长期储蓄存入表单应选择触发操作的钱包');
      await page.locator('#extraDepositAmount').fill('25.00');
      await clickAndWaitHidden(page, '#extraDepositModal', '#extraDepositForm button[type="submit"]');
      await clickWalletMoreAction(page, `[data-balance-transfer="fund:${savings.id}"]`);
      await page.locator('[data-transfer-all]').click();
      assert.equal(await page.locator('#transferAmount').inputValue(), '125.00', '全部转入应填写储蓄的可用余额');
      await page.locator('#transferTarget').selectOption(increment.id);
      await clickAndWaitHidden(page, '#transferModal', '#transferForm button[type="submit"]');

      await page.locator(`[data-wallet-id="${source.id}"]`).click();
      await page.locator('#entryAmount').fill('12.34');
      await page.locator('#entryForm summary').click();
      await page.locator('#entryNote').fill('功能测试支出');
      await clickAndWaitHidden(page, '#entryModal', '#entryForm button[type="submit"]');

      let state = await readState(page);
      assert.ok(state.entries.some(item => item.fundId === source.id && item.kind === 'extra-income' && item.amountCents === 2500), '临时收入应写入固定钱包账本');
      assert.ok(state.entries.some(item => item.fundId === target.id && item.kind === 'transfer-in' && item.amountCents === 4000), '固定钱包转入应进入目标钱包');
      assert.ok(state.entries.some(item => item.fundId === savings.id && item.kind === 'transfer-out' && item.amountCents === 12500), '普通长期储蓄应保留转出流水');
      assert.ok(state.entries.some(item => item.fundId === increment.id && item.kind === 'savings-in' && item.amountCents === 12500), '长期储蓄之间转入应保留储蓄余额流水');
      const expense = state.entries.find(item => item.fundId === source.id && item.kind === 'expense' && item.note === '功能测试支出');
      assert.ok(expense, '通过钱包卡片记账应保存支出');

      await page.reload({ waitUntil: 'domcontentloaded' });
      state = await readState(page);
      assert.ok(state.entries.some(item => item.id === expense.id), '重新载入后支出流水应保留');
      assert.equal(state.funds.find(item => item.id === source.id).allowanceCents, 30000, '转入、临时收入和支出都不能改固定额度');

      const cycle = state.cycles.find(item => item.endAt == null);
      const allocationsBeforeStop = structuredClone(cycle.allocations);
      const balanceBeforeStop = await readWalletBalanceCents(page, source.id);
      await clickWalletMoreAction(page, `[data-disable-fund="${source.id}"]`);
      await confirmDialog(page);
      state = await readState(page);
      assert.ok(state.funds.find(item => item.id === source.id).disabledAt, '更多菜单中的停用钱包应实际生效');
      assert.equal(state.cycles.find(item => item.id === cycle.id).allocations[source.id].amountCents, allocationsBeforeStop[source.id].amountCents,
        '停用不得释放本期已经分配的额度');
      assert.equal(await readWalletBalanceCents(page, source.id), balanceBeforeStop, '停用应保留当前余额');
      await clickWalletMoreAction(page, `[data-enable-fund="${source.id}"]`);
      state = await readState(page);
      assert.equal(state.funds.find(item => item.id === source.id).disabledAt, null, '更多菜单中的恢复钱包应实际生效');
      assert.equal(state.cycles.find(item => item.id === cycle.id).allocations[source.id].amountCents, allocationsBeforeStop[source.id].amountCents,
        '恢复不得补发或改写本期额度');

      await setSalary(page, '2300.00');
      state = await readState(page);
      assert.equal(state.salaryCents, 500000, '计划分配超出工资时应拒绝保存工资变更');
      assert.match(await page.locator('#toast').textContent(), /超过月到手工资/);
    }
  },
  {
    name: '计划消费待确认与迁移删除保留未来计划和历史流水',
    async run(page) {
      const before = await readState(page);
      const original = before.funds.find(item => item.id === 'daily');
      const oldEntryIds = before.entries.filter(item => item.fundId === original.id).map(item => item.id);
      const rule = await createRule(page, original.id, { name: '迁移回归计划', frequency: 'month', amount: '33.00' });
      let state = await readState(page);
      const pending = state.occurrences.find(item => item.ruleId === rule.id && item.status === 'pending');
      assert.ok(pending, '到期计划应先生成待确认账单');
      assert.equal(state.entries.filter(item => item.occurrenceId === pending.id && item.kind === 'expense').length, 0, '待确认账单生成时不得自动记支出');
      const dueAt = state.rules.find(item => item.id === rule.id).nextDueAt;

      await page.locator(`[data-delete-fund="${original.id}"]`).click();
      assert.match(await page.locator('#deleteFundRules').textContent(), /定时规则 1 条/);
      assert.match(await page.locator('#deleteFundPending').textContent(), /新规则 1 笔/);
      assert.equal(await page.locator('#deleteFundForm button[type="submit"]').isDisabled(), true, '有余额的钱包不能被直接删除');
      assert.match(await page.locator('#deleteFundBalance').textContent(), /需先处理余额/);
      const snapshotAllocation = before.cycles.find(item => item.endAt == null).allocations[original.id].amountCents;
      await page.locator('#deleteFundModal .modal-heading [data-close="deleteFundModal"]').click();
      await clickWalletMoreAction(page, `[data-balance-transfer="fund:${original.id}"]`);
      await page.locator('[data-transfer-all]').click();
      await page.locator('#transferTarget').selectOption('reserve');
      await clickAndWaitHidden(page, '#transferModal', '#transferForm button[type="submit"]');
      assert.equal(await readWalletBalanceCents(page, original.id), 0, '先转出余额后原钱包应归零');

      await page.locator(`[data-delete-fund="${original.id}"]`).click();
      await page.locator('#deleteFundMode').selectOption('move');
      await page.locator('#deleteFundTarget').selectOption('reserve');
      await clickAndWaitHidden(page, '#deleteFundModal', '#deleteFundForm button[type="submit"]');

      state = await readState(page);
      assert.equal(state.funds.some(item => item.id === original.id), false, '删除后钱包应移除');
      assert.equal(state.cycles.find(item => item.endAt == null).allocations[original.id].amountCents, snapshotAllocation,
        '删除不得释放本期已分配的额度');
      assert.ok(oldEntryIds.every(id => state.entries.some(item => item.id === id)), '已发生的历史流水应继续保留');
      assert.equal(state.rules.find(item => item.id === rule.id).fundId, 'reserve', '未来规则应迁移到目标钱包');
      assert.equal(state.rules.find(item => item.id === rule.id).nextDueAt, dueAt, '迁移不得改写下次到期时间');
      assert.equal(state.occurrences.find(item => item.id === pending.id).fundId, 'reserve', '未完成账单应迁移到目标钱包');
      assert.equal(state.occurrences.find(item => item.id === pending.id).status, 'pending', '迁移不得自动确认账单');
    }
  },
  {
    name: '暂停计划后删除最后钱包，首页无钱包仍可取消待确认账单',
    async run(page) {
      const rule = await createRule(page, 'daily', { name: '无钱包待取消', frequency: 'once', amount: '7.00' });
      let state = await readState(page);
      const pending = state.occurrences.find(item => item.ruleId === rule.id && item.status === 'pending');
      assert.ok(pending, '一次性到期计划应生成待确认账单');

      await clickWalletMoreAction(page, '[data-balance-transfer="fund:daily"]');
      await page.locator('[data-transfer-all]').click();
      await page.locator('#transferTarget').selectOption('reserve');
      await clickAndWaitHidden(page, '#transferModal', '#transferForm button[type="submit"]');
      const holder = await createFund(page, { name: '待确认账单过渡钱包', allowance: '0.00' });
      await clickWalletMoreAction(page, '[data-balance-transfer="fund:reserve"]');
      await page.locator('[data-transfer-all]').click();
      await page.locator('#transferTarget').selectOption(holder.id);
      await clickAndWaitHidden(page, '#transferModal', '#transferForm button[type="submit"]');

      await page.locator('[data-delete-fund="daily"]').click();
      await page.locator('#deleteFundTarget').selectOption('reserve');
      await clickAndWaitHidden(page, '#deleteFundModal', '#deleteFundForm button[type="submit"]');
      await page.locator('[data-delete-fund="reserve"]').click();
      await page.locator('#deleteFundTarget').selectOption(holder.id);
      await clickAndWaitHidden(page, '#deleteFundModal', '#deleteFundForm button[type="submit"]');
      state = await readState(page);
      assert.equal(state.rules.find(item => item.id === rule.id).fundId, holder.id, '通过删除迁移关联计划后应保留目标钱包绑定');
      assert.equal(state.occurrences.find(item => item.id === pending.id).fundId, holder.id, '待确认账单应随关联计划迁移');

      const remainingCents = await readWalletBalanceCents(page, holder.id);
      if (remainingCents > 0) {
        await page.locator(`[data-wallet-id="${holder.id}"]`).click();
        await page.locator('#entryAmount').fill((remainingCents / 100).toFixed(2));
        await page.locator('#entryForm summary').click();
        await page.locator('#entryNote').fill('清理测试过渡余额');
        await clickAndWaitHidden(page, '#entryModal', '#entryForm button[type="submit"]');
      }
      await page.locator(`[data-delete-fund="${holder.id}"]`).click();
      assert.equal(await page.locator('#deleteFundMode').inputValue(), 'pause', '没有其他钱包时应默认暂停计划并保留待确认账单');
      await clickAndWaitHidden(page, '#deleteFundModal', '#deleteFundForm button[type="submit"]');
      state = await readState(page);
      assert.equal(state.rules.find(item => item.id === rule.id).active, false, '暂停删除应停止后续计划');
      assert.equal(state.occurrences.find(item => item.id === pending.id).fundId, null, '暂停删除应解除待确认账单的钱包绑定');
      assert.equal(state.occurrences.find(item => item.id === pending.id).status, 'pending', '暂停删除应保留未完成账单');
      assert.equal((await readState(page)).funds.length, 0, '最后一个钱包删除后应没有可用钱包');
      const pendingRow = page.locator(`#homePendingList [data-record-id="${pending.id}"]`);
      await pendingRow.waitFor();
      await page.locator(`#homePendingList [data-pending-cancel][data-record-id="${pending.id}"]`).click();
      await confirmDialog(page);
      state = await readState(page);
      assert.equal(state.occurrences.find(item => item.id === pending.id).status, 'cancelled', '没有钱包时仍可取消待确认账单');
      assert.equal(state.entries.some(item => item.occurrenceId === pending.id && item.kind === 'expense'), false, '取消不能生成支出');
    }
  },
  {
    name: '手动刷新、历史实际日期、盈余回溯、月度年度历史报表与盈余明细刷新',
    async run(page) {
      await setSalary(page, '2500.00');
      const noAutoDeposit = await createFund(page, { name: '功能测试零自动存入', type: 'increment', contribution: '0.00', opening: '0.00' });
      const autoDeposit = await createFund(page, { name: '功能测试每期自动存入', type: 'increment', contribution: '10.00', opening: '0.00' });
      const noAutoBalanceBefore = await readWalletBalanceCents(page, noAutoDeposit.id);
      const autoBalanceBefore = await readWalletBalanceCents(page, autoDeposit.id);
      assert.equal(noAutoBalanceBefore, 0, '每期自动存入为 0 的长期储蓄不应凭空增加余额');
      assert.equal(autoBalanceBefore, 1000, '新建长期储蓄时应记录本期设定的自动存入');
      const rule = await createRule(page, 'daily', { name: '历史日期计划', frequency: 'once', amount: '5.00' });
      let state = await readState(page);
      const oldCycle = state.cycles.find(item => item.endAt == null);
      const pending = state.occurrences.find(item => item.ruleId === rule.id && item.status === 'pending');
      assert.ok(oldCycle && pending, '应有当前周期和待确认账单');

      await page.locator('[data-page="settingsPage"]').click();
      await page.locator('#refreshNowBtn').click();
      await page.locator('[data-refresh-kind="new"]').click();
      await confirmDialog(page);
      state = await readState(page);
      const closedAt = state.cycles.find(item => item.id === oldCycle.id).endAt;
      assert.ok(closedAt >= FIXED_TIME.getTime() && closedAt < FIXED_TIME.getTime() + 60000, '手动刷新应结束当前周期');
      assert.ok(state.savingsEntries.some(item => item.kind === 'surplus-in' && item.sourceCycleId === oldCycle.id), '手动新周期应归集上期正余额');
      const newCycle = state.cycles.find(item => item.endAt == null);
      const autoDepositRows = state.entries.filter(item => item.fundId === autoDeposit.id && item.kind === 'increment' && item.cycleId === newCycle.id);
      assert.equal(autoDepositRows.length, 1, '长期储蓄每个新发薪周期只应自动存入一次');
      assert.equal(autoDepositRows[0].amountCents, 1000, '新周期自动存入金额应等于钱包设置');
      assert.equal(state.entries.filter(item => item.fundId === noAutoDeposit.id && item.kind === 'increment' && item.cycleId === newCycle.id).length, 0,
        '每期自动存入为 0 的长期储蓄在新周期不应生成入账');
      const settledBefore = state.savingsEntries.filter(item => item.kind === 'surplus-in' && item.sourceCycleId === oldCycle.id && item.sourceFundId === 'daily').reduce((sum, item) => sum + item.amountCents, 0);
      assert.ok(settledBefore > 20000, '测试周期应有足够正余额供回溯调整');

      await page.locator('[data-page="walletsPage"]').click();
      assert.equal(await readWalletBalanceCents(page, noAutoDeposit.id), noAutoBalanceBefore, '每期自动存入为 0 的余额应跨新周期保持不变');
      assert.equal(await readWalletBalanceCents(page, autoDeposit.id), autoBalanceBefore + 1000, '正金额自动存入应使长期储蓄余额增加一次');
      await page.locator('#homePendingList [data-handle-pending]').click();
      await page.locator('#pendingFund').selectOption('daily');
      await page.locator('#pendingAmount').fill('200.00');
      await page.locator('#pendingDate').fill('2026-10-10');
      await clickAndWaitHidden(page, '#pendingModal', '#pendingForm button[type="submit"]');
      state = await readState(page);
      const actualExpense = state.entries.find(item => item.occurrenceId === pending.id && item.kind === 'expense');
      assert.ok(actualExpense, '确认待确认账单应生成真实支出');
      assert.equal(actualExpense.amountCents, 20000, '确认时应允许修改实际金额');
      assert.equal(actualExpense.date, '2026-10-10', '确认时应允许填写实际付款日期');
      const settledAfter = state.savingsEntries.filter(item => item.kind === 'surplus-in' && item.sourceCycleId === oldCycle.id && item.sourceFundId === 'daily').reduce((sum, item) => sum + item.amountCents, 0);
      assert.equal(settledAfter, settledBefore - actualExpense.amountCents, '补记旧周期实际支出应重算上期盈余');

      await page.locator('[data-page="billsPage"]').click();
      await page.locator('#reportTabs [data-report="month"]').click();
      assert.equal((await page.locator('#reportTotal').textContent()).trim(), money(0), '新周期月报不应包含上周期的回溯支出');
      await page.locator('#reportTabs [data-report="year"]').click();
      const yearExpected = state.entries.filter(item => item.kind === 'expense' && new Date(item.timestamp).getFullYear() === 2026).reduce((sum, item) => sum + item.amountCents, 0);
      assert.equal((await page.locator('#reportTotal').textContent()).trim(), money(yearExpected), '年度报表应汇总全年发薪周期支出');
      await page.locator('#reportTabs [data-report="history"]').click();
      const historyExpected = state.entries.filter(item => item.kind === 'expense' && item.timestamp >= oldCycle.startAt && item.timestamp < closedAt).reduce((sum, item) => sum + item.amountCents, 0);
      assert.equal((await page.locator('#reportTotal').textContent()).trim(), money(historyExpected), '历史周期报表应包含真实日期对应的支出');

      await page.locator(`#allRecordsList [data-delete-entry="${actualExpense.id}"]`).click();
      await confirmDialog(page);
      state = await readState(page);
      const settledRestored = state.savingsEntries.filter(item => item.kind === 'surplus-in' && item.sourceCycleId === oldCycle.id && item.sourceFundId === 'daily').reduce((sum, item) => sum + item.amountCents, 0);
      assert.equal(settledRestored, settledBefore, '删除回溯支出后应恢复对应的盈余归集');
      const savingsRestored = state.savingsEntries.reduce((sum, item) => sum + (item.kind === 'surplus-in' ? item.amountCents : -item.amountCents), 0);

      await page.locator('[data-page="walletsPage"]').click();
      await page.locator('[data-savings-expense]').click();
      await page.locator('#entryAmount').fill('1.00');
      await page.locator('#entryForm summary').click();
      await page.locator('#entryNote').fill('盈余明细刷新回归');
      await clickAndWaitHidden(page, '#entryModal', '#entryForm button[type="submit"]');
      const balanceBeforeDelete = savingsRestored - 100;
      await page.locator('[data-savings-detail]').click();
      assert.equal((await page.locator('#savingsDetailBalance strong').textContent()).trim(), money(balanceBeforeDelete), '盈余明细应显示当前余额');
      await page.locator('#savingsDetailRecords [data-delete-entry^="savings-"]').click();
      await confirmDialog(page);
      assert.equal((await page.locator('#savingsDetailBalance strong').textContent()).trim(), money(savingsRestored), '删除支出后已打开的盈余明细应立即刷新余额');
      assert.equal(await page.locator('#savingsDetailRecords [data-delete-entry^="savings-"]').count(), 0, '删除支出后已打开的盈余明细应移除旧记录');
      assert.equal((await page.locator('#homeSpent').textContent()).trim(), money(0), '删除盈余支出后首页本期支出应同步更新');
    }
  },
  {
    name: '通过设置页导入有效 v4 备份，并拒绝不完整备份而保留现有数据',
    async run(page) {
      const initial = await readState(page);
      const imported = structuredClone(initial);
      imported.schemaVersion = 4;
      imported.funds = imported.funds.map(({ disabledAt, ...fund }) => fund);
      imported.cycles = imported.cycles.map(({ overdrafts, surplusExcludedFundIds, ...cycle }) => cycle);
      delete imported.lastExportAt;
      imported.salaryCents = 250000;
      for (const cycle of imported.cycles) {
        cycle.salaryCents = 250000;
        if (cycle.salarySnapshot?.netCents != null) cycle.salarySnapshot.netCents = 250000;
      }
      await page.locator('[data-page="settingsPage"]').click();
      await page.locator('#importFile').setInputFiles({ name: 'valid-v4.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
      await page.locator('#confirmModal.open').waitFor();
      await confirmDialog(page);
      let state = await readState(page);
      assert.equal(state.schemaVersion, 5, '旧版 v4 备份应实际迁移为 v5');
      assert.equal(state.lastExportAt, null, '迁移后的备份时间应初始化为空');
      assert.ok(state.funds.every(item => item.disabledAt === null), 'v4 钱包应迁移为启用状态');
      assert.ok(state.cycles.every(item => Array.isArray(item.overdrafts) && Array.isArray(item.surplusExcludedFundIds)), 'v4 周期应初始化 v5 超支与结余标记');
      assert.equal(state.salaryCents, 250000, '有效 v4 备份应替换当前工资设置');
      assert.deepEqual(state.funds.map(item => item.id).sort(), initial.funds.map(item => item.id).sort(), '有效 v4 导入应保留备份中的钱包');

      const beforeInvalidImport = structuredClone(state);
      const invalid = structuredClone(state);
      delete invalid.savingsEntries;
      await page.locator('#importFile').setInputFiles({ name: 'invalid-v4.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
      await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('备份无效，现有数据未更改'));
      state = await readState(page);
      assert.equal(state.salaryCents, beforeInvalidImport.salaryCents, '无效备份不得覆盖现有工资设置');
      assert.deepEqual(state.funds.map(item => item.id).sort(), beforeInvalidImport.funds.map(item => item.id).sort(), '无效备份不得替换现有钱包');
    }
  },
  {
    name: '自动发薪账户入账幂等，手动新周期与重置不增加到账',
    async run(page) {
      await page.locator('#addAccountBtn').click();
      await page.locator('#accountType').selectOption('provident');
      await page.locator('#accountName').fill('功能测试公积金');
      await page.locator('#accountOpening').fill('0');
      await page.locator('#accountDefaultPersonal').fill('100.00');
      await page.locator('#accountDefaultCompany').fill('200.00');
      await clickAndWaitHidden(page, '#accountSetupModal', '#accountSetupForm button[type="submit"]');
      let state = await readState(page);
      const account = state.accounts.find(item => item.name === '功能测试公积金');
      assert.ok(account, '账户应通过表单创建');
      assert.equal(state.accountEntries.filter(item => item.accountId === account.id && item.kind === 'provident-credit').length, 0, '添加账户不会立即发放定期到账');

      await page.locator('[data-page="settingsPage"]').click();
      await page.locator('#refreshNowBtn').click();
      await page.locator('[data-refresh-kind="new"]').click();
      await confirmDialog(page);
      await page.locator('#refreshNowBtn').click();
      await page.locator('[data-refresh-kind="reset"]').click();
      await confirmDialog(page);
      state = await readState(page);
      assert.equal(state.accountEntries.filter(item => item.accountId === account.id && item.kind === 'provident-credit').length, 0, '手动开始新周期或本周期重置不增加账户到账');

      await page.clock.setSystemTime(new Date('2026-10-20T00:01:00+08:00'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      state = await readState(page);
      const credits = state.accountEntries.filter(item => item.accountId === account.id && item.kind === 'provident-credit');
      assert.equal(credits.length, 1, '自动发薪到期后应只生成一笔账户到账');
      assert.equal(credits[0].amountCents, 30000, '公积金到账应合并个人与单位金额');
      const scheduledKey = String(new Date('2026-10-20T00:00:00+08:00').getTime());
      assert.ok(state.accountProcessedKeys.includes(`${account.id}:${scheduledKey}`), '账户到账应写入周期幂等标记');
      await page.reload({ waitUntil: 'domcontentloaded' });
      state = await readState(page);
      assert.equal(state.accountEntries.filter(item => item.accountId === account.id && item.kind === 'provident-credit').length, 1, '再次打开页面不得重复发放同一周期到账');

      const automatic = state.accountEntries.find(item => item.accountId === account.id && item.scheduledKey === scheduledKey);
      await page.locator(`[data-account-action="credit"][data-account-id="${account.id}"]`).click();
      assert.equal(await page.locator('#accountCreditMode').inputValue(), 'correct', '已有本月自动到账时应默认更正原记录');
      await page.locator('#accountPersonalAmount').fill('0.00');
      await page.locator('#accountCompanyAmount').fill('0.00');
      await clickAndWaitHidden(page, '#accountEntryModal', '#accountEntryForm button[type="submit"]');
      state = await readState(page);
      const corrected = state.accountEntries.find(item => item.id === automatic.id);
      assert.equal(corrected.amountCents, 0, '实际未到账时允许把自动登记金额更正为零');
      assert.equal(corrected.scheduledKey, scheduledKey, '更正自动到账应保留幂等标记');
      assert.equal(state.accountEntries.filter(item => item.accountId === account.id && item.scheduledKey === scheduledKey).length, 1,
        '把自动到账更正为零后再次打开也不得重复生成');

      await page.locator(`[data-account-action="credit"][data-account-id="${account.id}"]`).click();
      await page.locator('#accountCreditMode').selectOption('extra');
      await page.locator('#accountPersonalAmount').fill('50.00');
      await page.locator('#accountCompanyAmount').fill('50.00');
      await clickAndWaitHidden(page, '#accountEntryModal', '#accountEntryForm button[type="submit"]');
      state = await readState(page);
      assert.equal(state.accountEntries.filter(item => item.accountId === account.id && item.scheduledKey === scheduledKey).length, 1,
        '额外到账不能改写自动入账记录');
      assert.equal(state.accountEntries.filter(item => item.accountId === account.id && !item.scheduledKey && item.amountCents === 10000).length, 1,
        '额外到账应新增独立的手动流水');
    }
  },
  {
    name: '停用负余额跨两个发薪日只生成一次超支并持久化 v5 元数据',
    async run(page) {
      await page.locator('[data-wallet-id="daily"]').click();
      await page.locator('#entryAmount').fill('1000.00');
      await page.locator('#entryForm summary').click();
      await page.locator('#entryNote').fill('跨周期超支回归');
      await clickAndWaitHidden(page, '#entryModal', '#entryForm button[type="submit"]');
      const before = await readState(page);
      const openCycle = before.cycles.find(item => item.endAt == null);
      assert.equal(openCycle.allocations.daily.amountCents, 140000, '本期快照应包含原周期定额');
      assert.match(await page.locator('[data-wallet-id="daily"] .wallet-balance strong').textContent(), /58\.88/);

      await page.locator('[data-page="settingsPage"]').click();
      await page.locator('#refreshNowBtn').click();
      await page.locator('[data-refresh-kind="reset"]').click();
      await page.locator('#confirmModal.open').waitFor();
      assert.match(await page.locator('#confirmMessage').textContent(), /负余额/);
      await confirmDialog(page);
      await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('仍有待处理负余额'));
      await page.locator('#refreshModal [data-close="refreshModal"]').click();

      await page.locator('[data-page="walletsPage"]').click();
      await clickWalletMoreAction(page, '[data-disable-fund="daily"]');
      await confirmDialog(page);
      const stopped = await readState(page);
      assert.ok(stopped.funds.find(item => item.id === 'daily').disabledAt, '停用状态应写入 v5 钱包元数据');
      assert.equal(stopped.cycles.find(item => item.id === openCycle.id).allocations.daily.amountCents, 140000,
        '停用不能减少已分配的本期额度');

      await page.locator('[data-page="settingsPage"]').click();
      await page.locator('#refreshNowBtn').click();
      await page.locator('[data-refresh-kind="new"]').click();
      await page.locator('#confirmModal.open').waitFor();
      assert.match(await page.locator('#confirmMessage').textContent(), /本期预计新增缺口 ¥58\.88/);
      assert.match(await page.locator('#confirmMessage').textContent(), /刷新后待处理合计 ¥58\.88/);
      await confirmDialog(page);
      let state = await readState(page);
      let transfers = state.entries.filter(item => item.kind === 'overdraft-transfer' && item.sourceFundId === 'daily');
      assert.equal(transfers.length, 1, '新周期应把停用钱包历史负余额转换为一条待处理超支');
      assert.equal(transfers[0].amountCents, 5888, '登记缺口应与停用钱包的实际负余额相同');
      assert.equal(state.cycles.find(item => item.id === openCycle.id).overdrafts.find(item => item.sourceFundId === 'daily').amountCents, 5888,
        '周期超支元数据应保存精确金额');
      assert.equal(state.cycles.find(item => item.id === openCycle.id).surplusExcludedFundIds.includes('daily'), true,
        '周期应保存停用钱包的盈余排除标记');

      await page.clock.setSystemTime(new Date('2026-10-20T00:01:00+08:00'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.clock.setSystemTime(new Date('2026-11-20T00:01:00+08:00'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      state = await readState(page);
      transfers = state.entries.filter(item => item.kind === 'overdraft-transfer' && item.sourceFundId === 'daily');
      assert.equal(transfers.length, 1, '跨两个自动发薪周期并重复载入，不得重复登记停用钱包超支');
      assert.ok(state.funds.find(item => item.id === 'daily').disabledAt, 'v5 重新载入应保留钱包停用状态');
      assert.equal(state.cycles.find(item => item.id === openCycle.id).overdrafts[0].amountCents, 5888,
        'v5 重新载入应保留原周期超支记录');
      assert.deepEqual(state.cycles.find(item => item.id === openCycle.id).surplusExcludedFundIds, ['daily'],
        'v5 重新载入应保留盈余排除标记');
      assert.equal(state.funds.find(item => item.id === 'daily').disabledAt, stopped.funds.find(item => item.id === 'daily').disabledAt,
        '多次调和不得改变钱包停用时间');

      const v5Backup = structuredClone(state);
      await page.locator('#importFile').setInputFiles({ name: 'v5-overdraft.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(v5Backup)) });
      await page.locator('#confirmModal.open').waitFor();
      await confirmDialog(page);
      state = await readState(page);
      assert.equal(state.schemaVersion, 5, '导入 v5 备份应保留 v5 格式');
      assert.ok(state.funds.find(item => item.id === 'daily').disabledAt, 'v5 导入应保留钱包停用状态');
      assert.equal(state.cycles.find(item => item.id === openCycle.id).overdrafts[0].amountCents, 5888, 'v5 导入应保留超支金额');
      assert.equal(state.cycles.find(item => item.id === openCycle.id).surplusExcludedFundIds.includes('daily'), true, 'v5 导入应保留结余排除元数据');
      assert.equal(state.entries.filter(item => item.kind === 'overdraft-transfer' && item.sourceFundId === 'daily').length, 1,
        'v5 导入应保留且不重复历史超支转移');
    }
  }
];

async function main() {
  const browser = await chromium.launch({ executablePath: EDGE_PATH, headless: true });
  const results = [];
  for (const testCase of cases) {
    let context;
    let pageErrors = [];
    try {
      const session = await createBrowserPage(browser);
      ({ context, pageErrors } = session);
      await testCase.run(session.page);
      if (pageErrors.length) throw new Error(`页面运行时错误：\n${pageErrors.join('\n')}`);
      results.push({ name: testCase.name, status: 'PASS', pageErrors });
      console.log(`[PASS] ${testCase.name}`);
    } catch (error) {
      results.push({ name: testCase.name, status: 'FAIL', error: error.stack || error.message, pageErrors });
      console.log(`[FAIL] ${testCase.name}`);
      console.log(error.stack || error.message);
      if (pageErrors.length) console.log(`PAGEERRORS:\n${pageErrors.join('\n')}`);
    } finally {
      if (context) await context.close().catch(() => {});
    }
  }
  await browser.close();
  const passed = results.filter(result => result.status === 'PASS').length;
  console.log(`\n${passed}/${results.length} functional cases passed.`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
