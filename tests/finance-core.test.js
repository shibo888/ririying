// 运行：node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../finance-core.js");

const NOW = new Date("2026-11-02T10:00:00+08:00").getTime();

function asset(subtype, yuan, extra) {
  return Object.assign(
    { subtype, name: F.findSubtype("asset", subtype).subtype.label, amountCents: Math.round(yuan * 100), status: "confirmed" },
    extra
  );
}
function liab(subtype, yuan, extra) {
  return Object.assign(
    {
      subtype,
      name: F.findSubtype("liability", subtype).subtype.label,
      amountCents: Math.round(yuan * 100),
      status: "confirmed",
      incurredDate: "2026-10-31",
      paid: false
    },
    extra
  );
}
function add(state, kind, item) {
  const v = F.validateItem(kind, item, state, NOW);
  assert.deepEqual(v.errors, [], `unexpected errors for ${item.name}`);
  return F.upsertItem(state, kind, item, NOW).state;
}

test("parseMoney 精确到分并拒绝非法输入", () => {
  assert.deepEqual(F.parseMoney("1,234.56"), { ok: true, cents: 123456 });
  assert.deepEqual(F.parseMoney("0.1"), { ok: true, cents: 10 });
  assert.deepEqual(F.parseMoney("¥9540"), { ok: true, cents: 954000 });
  assert.equal(F.parseMoney("0.07").cents, 7); // 浮点陷阱
  assert.equal(F.parseMoney("-5").ok, false);
  assert.equal(F.parseMoney("abc").ok, false);
  assert.equal(F.parseMoney("1.234").ok, false);
  assert.equal(F.parseMoney("").empty, true);
  assert.equal(F.parseMoney("1e5").ok, false);
});

test("formatMoney 保留两位小数与千分位", () => {
  assert.equal(F.formatMoney(123456), "¥1,234.56");
  assert.equal(F.formatMoney(-5), "-¥0.05");
  assert.equal(F.formatMoney(100, { signed: true }), "+¥1.00");
  assert.equal(F.formatMoney(null), "未知");
});

test("验收1-3：资产、负债、净资产随录入正确更新", () => {
  let s = F.createEmptyState();
  s = add(s, "asset", asset("bank_card", 20000));
  s = add(s, "asset", asset("cash_on_hand", 1500.5));
  s = add(s, "asset", asset("raw", 3200, { status: "estimated" }));
  s = add(s, "asset", asset("lease_deposit", 8000, { faceCents: 1000000, status: "estimated" }));
  s = add(s, "asset", asset("prepaid_rent", 12000, { periodStart: "2026-11", periodEnd: "2027-01" }));
  s = add(s, "asset", asset("sqb", 2345.67));
  let t = F.computeTotals(s);
  assert.equal(t.assetsCents, 2000000 + 150050 + 320000 + 800000 + 1200000 + 234567);

  s = add(s, "liability", liab("supplier", 4500));
  s = add(s, "liability", liab("owner_labor", 6000));
  s = add(s, "liability", liab("staff_wage", 3800));
  s = F.updateMemberDeposit(s, {
    enabled: true,
    systemTotalCents: 954000,
    composition: "split",
    paidCents: 870000,
    bonusCents: 84000,
    basis: "full"
  });
  t = F.computeTotals(s);
  assert.equal(t.liabilitiesCents, 450000 + 600000 + 380000 + 954000);
  assert.equal(t.netCents, t.assetsCents - t.liabilitiesCents);
  assert.equal(t.netCents, 4704617 - 2384000);
  // 分类占比
  const cashCat = t.assetCategories.find((c) => c.key === "cash");
  assert.equal(cashCat.totalCents, 2150050);
  assert.ok(Math.abs(t.assetCategories.reduce((x, c) => x + c.share, 0) - 1) < 1e-9);
});

test("验收4：编辑、删除后计算正确", () => {
  let s = F.createEmptyState();
  s = add(s, "asset", asset("bank_card", 100));
  s = add(s, "asset", asset("wechat", 50));
  const wechat = s.assets[1];
  s = F.upsertItem(s, "asset", Object.assign({}, wechat, { amountCents: 8000 }), NOW).state;
  assert.equal(F.computeTotals(s).assetsCents, 18000);
  s = F.deleteItem(s, "asset", wechat.id, NOW).state;
  assert.equal(F.computeTotals(s).assetsCents, 10000);
  assert.equal(F.computeTotals(s).netCents, 10000);
  // 变化记录：新增、修改、删除
  const log = F.changesForItem(s, wechat.id).map((e) => e.action);
  assert.deepEqual(log, ["delete", "update", "create"]);
});

test("验收5：持久化读写（模拟 localStorage）", () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  let s = F.createEmptyState();
  s = add(s, "asset", asset("bank_card", 99.99));
  F.saveState(storage, s);
  const loaded = F.loadState(storage);
  assert.equal(loaded.fresh, false);
  assert.equal(F.computeTotals(loaded.state).assetsCents, 9999);
  // 损坏数据：备份而不是静默丢失
  mem.set(F.STORAGE_KEY, "{oops");
  const broken = F.loadState(storage);
  assert.ok(broken.error);
  assert.ok([...mem.keys()].some((k) => k.startsWith(`${F.STORAGE_KEY}-broken-`)));
});

test("验收6：快照保留当时金额和口径，修改当前数据不覆盖历史", () => {
  let s = F.createEmptyState();
  s = add(s, "asset", asset("bank_card", 1000));
  s = F.updateMemberDeposit(s, { enabled: true, systemTotalCents: 954000, composition: "unknown" });
  s = F.addSnapshot(s, { date: "2026-10-31", note: "月底盘点" }, NOW).state;
  const snap = s.snapshots[0];
  assert.equal(snap.totals.assetsCents, 100000);
  assert.match(snap.basis.member, /构成未知/);

  const bank = s.assets[0];
  s = F.upsertItem(s, "asset", Object.assign({}, bank, { amountCents: 300000 }), NOW).state;
  s = F.updateMemberDeposit(s, Object.assign({}, s.memberDeposit, { estimateCents: 800000 }));
  assert.equal(s.snapshots[0].totals.assetsCents, 100000, "历史快照不能被修改");
  assert.equal(s.snapshots[0].assets[0].amountCents, 100000);

  s = F.addSnapshot(s, { date: "2026-11-02" }, NOW + 1000).state;
  const cmp = F.compareSnapshots(s.snapshots[0], s.snapshots[1]);
  assert.equal(cmp.assetsDiffCents, 200000);
  assert.equal(cmp.liabilitiesDiffCents, 800000);
  assert.equal(cmp.netDiffCents, 200000 - 800000);
  assert.equal(cmp.basisChanged, true);
  assert.equal(cmp.assetItems[0].fromCents, 100000);
  assert.equal(cmp.assetItems[0].toCents, 300000);
  // 删除快照
  s = F.deleteSnapshot(s, s.snapshots[0].id);
  assert.equal(s.snapshots.length, 1);
});

test("验收7：平台资金到账不重复统计", () => {
  let s = F.createEmptyState();
  s = add(s, "asset", asset("bank_card", 1000));
  s = add(s, "asset", asset("meituan", 600));
  const before = F.computeTotals(s).assetsCents;
  const [bank, mt] = s.assets;
  const r = F.transferSettlement(s, mt.id, bank.id, 40000, NOW);
  assert.ok(!r.error);
  s = r.state;
  assert.equal(F.computeTotals(s).assetsCents, before, "到账只是转移，资产总额不变");
  assert.equal(s.assets[0].amountCents, 140000);
  assert.equal(s.assets[1].amountCents, 20000);
  assert.match(F.transferSettlement(s, mt.id, bank.id, 30000, NOW).error, /不能超过/);
  assert.match(F.transferSettlement(s, bank.id, mt.id, 100, NOW).error, /待结算/);
});

test("验收8：预付房租与未付房租同一期间不能重复", () => {
  let s = F.createEmptyState();
  s = add(s, "asset", asset("prepaid_rent", 12000, { periodStart: "2026-11", periodEnd: "2027-01" }));
  const overlap = liab("unpaid_rent", 4000, { periodStart: "2026-12", periodEnd: "2026-12" });
  assert.match(F.validateItem("liability", overlap, s, NOW).errors.join(), /同一期间的房租/);
  const earlier = liab("unpaid_rent", 4000, { periodStart: "2026-10", periodEnd: "2026-10" });
  assert.deepEqual(F.validateItem("liability", earlier, s, NOW).errors, []);
  // 已支付的房租不会计入负债
  s = add(s, "liability", Object.assign(earlier, { paid: true }));
  assert.equal(F.computeTotals(s).liabilitiesCents, 0);
});

test("验收9：会员余额构成未知时不倒推实际充值金额", () => {
  let s = F.createEmptyState();
  s = add(s, "asset", asset("bank_card", 20000));
  s = F.updateMemberDeposit(s, { enabled: true, systemTotalCents: 954000, composition: "unknown", rule: "充300送30" });
  let t = F.computeTotals(s);
  assert.equal(t.member.counted, false);
  assert.equal(t.liabilitiesCents, 0, "未知且无暂估：不计入正式负债");
  assert.equal(t.pendingLiabilitiesCents, 954000, "整笔余额列为待确认");
  // 绝不出现 9540/1.1 = 8672.73
  const all = JSON.stringify(t);
  assert.ok(!all.includes("867272") && !all.includes("867273"));
  assert.ok(F.buildHints(s, t).some((h) => /尚未拆分/.test(h.text)));
  // 口径对比：全额 vs 暂不计入
  const full = t.memberScenarios.find((x) => x.key === "full");
  assert.equal(full.netCents, 2000000 - 954000);

  // 用户暂估
  s = F.updateMemberDeposit(s, Object.assign({}, s.memberDeposit, { estimateCents: 900000 }));
  t = F.computeTotals(s);
  assert.equal(t.liabilitiesCents, 900000);
  assert.equal(t.member.flag, "estimated");
  assert.equal(t.estimatedCount, 1);
  assert.match(t.member.basisLabel, /暂估/);
  assert.match(F.validateMemberDeposit(Object.assign({}, s.memberDeposit, { estimateCents: 999999999 })).errors[0], /不能超过/);

  // 已拆分：仅实际充值口径
  s = F.updateMemberDeposit(s, {
    enabled: true,
    systemTotalCents: 954000,
    composition: "split",
    paidCents: 880000,
    bonusCents: 74000,
    basis: "paid_only"
  });
  t = F.computeTotals(s);
  assert.equal(t.liabilitiesCents, 880000);
  const diff = t.memberScenarios.find((x) => x.key === "full");
  assert.equal(diff.netCents, 2000000 - 954000);
  assert.match(
    F.validateMemberDeposit({ enabled: true, systemTotalCents: 954000, composition: "split", paidCents: 1, bonusCents: 1, basis: "full" }).errors[0],
    /不一致/
  );
});

test("待确认与未知金额不按 0 静默计入", () => {
  let s = F.createEmptyState();
  const unknownAmount = asset("douyin", 0, { amountCents: null, status: "confirmed" });
  assert.match(F.validateItem("asset", unknownAmount, s, NOW).errors.join(), /待确认/);
  s = add(s, "asset", Object.assign(unknownAmount, { status: "pending" }));
  s = add(s, "asset", asset("alipay", 300, { status: "pending" }));
  s = add(s, "liability", liab("supplier", 700, { status: "pending" }));
  const t = F.computeTotals(s);
  assert.equal(t.assetsCents, 0);
  assert.equal(t.liabilitiesCents, 0);
  assert.equal(t.pendingAssetsCents, 30000);
  assert.equal(t.pendingLiabilitiesCents, 70000);
  assert.equal(t.pendingCount, 3);
  assert.equal(t.unknownAmountCount, 1);
});

test("人工与费用校验：未来未发生、重复记录、押金", () => {
  let s = F.createEmptyState();
  assert.match(
    F.validateItem("liability", liab("staff_wage", 3000, { incurredDate: "2026-12-31" }), s, NOW).errors.join(),
    /尚未发生/
  );
  s = add(s, "liability", liab("staff_wage", 3000, { paid: true }));
  const again = liab("staff_wage", 3000);
  const v = F.validateItem("liability", again, s, NOW);
  assert.deepEqual(v.errors, []);
  assert.match(v.warnings.join(), /既算已支付又算未支付/);
  assert.match(
    F.validateItem("asset", asset("lease_deposit", 12000, { faceCents: 1000000 }), s, NOW).errors.join(),
    /不能大于押金原额/
  );
  assert.match(F.validateItem("asset", asset("bank_card", 1, { amountCents: -100 }), s, NOW).errors.join(), /不小于 0/);
  assert.match(
    F.validateItem("liability", liab("supplier", 10, { dueDate: "2026-01-01" }), s, NOW).errors.join(),
    /不能早于/
  );
});

test("净资产为负时提示负值含义，且不判断盈亏", () => {
  let s = F.createEmptyState();
  s = add(s, "asset", asset("bank_card", 100));
  s = add(s, "liability", liab("supplier", 300));
  const t = F.computeTotals(s);
  assert.equal(t.netCents, -20000);
  const hints = F.buildHints(s, t);
  assert.ok(hints.some((h) => /净资产为负（-¥200.00）/.test(h.text)));
  assert.ok(hints.some((h) => /不等于累计经营利润/.test(h.text)));
  assert.ok(!hints.some((h) => /已经(盈利|亏损)/.test(h.text)));
});

test("预付费用未使用部分辅助计算", () => {
  assert.equal(F.unusedPrepaid(1200000, 3, 1).cents, 800000);
  assert.equal(F.unusedPrepaid(1000000, 3, 2).cents, 333334);
  assert.equal(F.unusedPrepaid(1000000, 3, 3).cents, 0);
  assert.ok(F.unusedPrepaid(100, 3, 4).error);
});
