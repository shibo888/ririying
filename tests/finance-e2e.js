// 浏览器端到端验收：node tests/finance-e2e.js
// 需要 Playwright（require('playwright')）。脚本会自己启动一个本地静态服务器。
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const SHOTS = process.env.SHOT_DIR || path.join(ROOT, "tests", "screenshots");

function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(ROOT, url === "/" ? "index.html" : url);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    const type = file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8";
    res.writeHead(200, { "Content-Type": type }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const text = async (sel) => (await page.locator(sel).textContent()).trim();
  const step = (name) => console.log(`✓ ${name}`);

  async function addItem(kind, category, opts) {
    await page.click(`[data-add="${kind}"][data-category="${category}"]`);
    await page.selectOption("#itemSubtype", opts.subtype);
    if (opts.name) await page.fill("#itemName", opts.name);
    if (opts.amount != null) await page.fill("#itemAmount", opts.amount);
    if (opts.face) await page.fill("#itemFace", opts.face);
    if (opts.periodStart) {
      await page.fill("#itemPeriodStart", opts.periodStart);
      await page.fill("#itemPeriodEnd", opts.periodEnd);
    }
    if (opts.helper) {
      await page.fill("#helpTotal", opts.helper[0]);
      await page.fill("#helpMonths", opts.helper[1]);
      await page.fill("#helpUsed", opts.helper[2]);
      await page.click("#helpApply");
    }
    if (opts.status) await page.check(`input[name="itemStatus"][value="${opts.status}"]`);
    if (opts.incurred) await page.fill("#itemIncurred", opts.incurred);
    await page.click("#itemSave");
  }

  // 0. 入口
  await page.goto(`${base}/index.html`);
  await page.click("a.tool-link");
  await page.waitForURL(/finance\.html/);
  assert.equal(await text("#assetsValue"), "¥0.00");
  assert.ok((await page.locator(".empty").count()) > 0, "空状态");
  step("首页入口可进入，空状态正常");

  // 1. 资产
  await addItem("asset", "cash", { subtype: "bank_card", amount: "20000" });
  await addItem("asset", "cash", { subtype: "cash_on_hand", amount: "1500.5" });
  await addItem("asset", "inventory", { subtype: "raw", amount: "3200" });
  await addItem("asset", "recoverable", { subtype: "lease_deposit", amount: "8000", face: "10000" });
  await addItem("asset", "prepaid", {
    subtype: "prepaid_rent",
    helper: ["12000", "3", "1"],
    periodStart: "2026-11",
    periodEnd: "2027-01"
  });
  assert.match(await text('[data-group="prepaid"]'), /¥8,000\.00/, "预付房租按未使用部分计入");
  await addItem("asset", "settlement", { subtype: "sqb", amount: "2345.67" });
  assert.equal(await text("#assetsValue"), "¥43,046.17");
  // 库存默认估算
  assert.ok(await page.locator('[data-group="inventory"] .badge.estimated').count());
  step("验收1：新增银行卡、现金、库存、押金、预付房租、平台待结算后资产总额 ¥43,046.17");

  // 非法金额
  await page.click('[data-add="asset"][data-category="cash"]');
  await page.fill("#itemAmount", "-100");
  await page.click("#itemSave");
  assert.match(await text("#itemErrors"), /不能为负数/);
  await page.fill("#itemAmount", "12.345");
  await page.click("#itemSave");
  assert.match(await text("#itemErrors"), /两位小数/);
  await page.click("#itemModal [data-close]");
  step("非法金额被拦截");

  // 2. 负债 + 会员
  await addItem("liability", "payable", { subtype: "supplier", amount: "4500", incurred: "2026-10-28" });
  await addItem("liability", "labor", { subtype: "owner_labor", amount: "6000", incurred: "2026-10-31" });
  await page.click('[data-member]');
  await page.fill("#mdTotal", "9540");
  await page.fill("#mdRule", "充300送30");
  await page.check('input[name="mdComposition"][value="unknown"]');
  await page.click('#memberForm button[type="submit"]');
  assert.equal(await text("#liabilitiesValue"), "¥10,500.00");
  assert.equal(await text("#pendingValue"), "¥9,540.00");
  const body = await page.textContent("body");
  assert.ok(!/8,672\.7/.test(body), "不得出现 9540/1.1 的推导");
  assert.match(await text("#hintList"), /尚未拆分/);
  assert.equal(await text("#netValue"), "¥32,546.17");
  step("验收2/3/9：负债 ¥10,500.00，会员余额构成未知列为待确认，净资产 ¥32,546.17");

  // 未来工资不能列为负债
  await addItem("liability", "labor", { subtype: "staff_wage", amount: "3800", incurred: "2099-01-01" });
  assert.match(await text("#itemErrors"), /尚未发生/);
  await page.click("#itemModal [data-close]");
  // 重复记录需要二次确认
  await addItem("liability", "payable", { subtype: "supplier", amount: "4500", incurred: "2026-10-28" });
  assert.match(await text("#itemWarnings"), /重复/);
  await page.click("#itemModal [data-close]");
  step("未来工资被拒绝；重复记录需要确认");

  // 3. 到账不重复
  await page.click('[data-transfer]');
  await page.fill("#transferAmount", "2000");
  await page.click('#transferForm button[type="submit"]');
  assert.equal(await text("#assetsValue"), "¥43,046.17");
  assert.match(await text('[data-group="settlement"]'), /¥345\.67/);
  assert.match(await text('[data-group="cash"]'), /¥22,000\.00/);
  step("验收7：平台到账 ¥2,000 后待结算减少、银行卡增加，资产总额不变");

  // 4. 预付房租与未付房租
  await addItem("liability", "other", {
    subtype: "unpaid_rent",
    amount: "4000",
    periodStart: "2026-12",
    periodEnd: "2026-12",
    incurred: "2026-11-01"
  });
  assert.match(await text("#itemErrors"), /同一期间的房租/);
  await page.click("#itemModal [data-close]");
  step("验收8：同一期间预付房租和应付房租不能重复");

  // 5. 编辑 / 删除
  await page.click('[data-group="payable"] [data-edit]');
  await page.fill("#itemAmount", "4000");
  await page.click("#itemSave");
  assert.equal(await text("#liabilitiesValue"), "¥10,000.00");
  await page.click('[data-group="cash"] [data-edit] >> nth=1');
  await page.click("#itemDelete");
  assert.ok(await page.locator("#confirmModal.open").count(), "删除前二次确认");
  await page.click("#confirmOk");
  assert.equal(await text("#assetsValue"), "¥41,545.67");
  assert.equal(await text("#netValue"), "¥31,545.67");
  // 标记已支付后不计入
  await page.click('[data-group="labor"] [data-edit]');
  await page.check("#itemPaid");
  await page.click("#itemSave");
  assert.equal(await text("#liabilitiesValue"), "¥4,000.00");
  assert.match(await text('[data-group="labor"]'), /已支付（不计入）1 项/);
  step("验收4：编辑、删除、标记已支付后合计正确");

  // 6. 刷新后仍在
  await page.reload();
  assert.equal(await text("#assetsValue"), "¥41,545.67");
  assert.equal(await text("#liabilitiesValue"), "¥4,000.00");
  assert.equal(await text("#pendingValue"), "¥9,540.00");
  step("验收5：刷新后数据仍在");

  // 7. 快照
  await page.click("#openSnapshot");
  await page.fill("#snapshotDate", "2026-10-31");
  await page.fill("#snapshotNote", "10 月底盘点");
  await page.click('#snapshotForm button[type="submit"]');
  // 会员余额改为暂估
  await page.click('[data-member]');
  await page.fill("#mdEstimate", "8000");
  await page.click('#memberForm button[type="submit"]');
  assert.equal(await text("#liabilitiesValue"), "¥12,000.00");
  assert.match(await text("#results"), /用户暂估口径（当前）/);
  await page.click("#openSnapshot");
  await page.fill("#snapshotDate", "2026-11-02");
  await page.click('#snapshotForm button[type="submit"]');
  assert.equal(await page.locator(".snapshot-row").count(), 2);
  await page.selectOption("#compareTo", { index: 2 });
  await page.click("#compareRun");
  assert.equal(await text("#compareNetDiff"), "-¥8,000.00");
  assert.match(await text("#compareResult"), /会员储值口径不同/);
  // 历史快照保留当时金额
  await page.click('.snapshot-row >> nth=1 >> [data-view]');
  assert.match(await text("#viewBody"), /¥37,545\.67/);
  assert.match(await text("#viewBody"), /构成未知/);
  await page.screenshot({ path: path.join(SHOTS, "snapshot-view.png") });
  await page.click("#viewModal [data-close]");
  step("验收6：快照保存、查看、比较正常，历史保留当时金额与口径");

  // 移动端无横向滚动
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `横向溢出 ${overflow}px`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, "finance-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: path.join(SHOTS, "finance-desktop.png"), fullPage: false });
  step("移动端 390px 无横向滚动");

  assert.deepEqual(errors, [], "页面无脚本错误");
  await browser.close();
  server.close();
  console.log("全部端到端验收通过");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
