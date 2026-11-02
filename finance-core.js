/*
 * 日日盈 · 门店财务状况 计算核心
 *
 * 纯函数模块：金额统一用「分」（整数）保存和计算，避免浮点误差。
 * 浏览器中挂到 window.FinanceCore，Node 中通过 module.exports 导出，便于自动化测试。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.FinanceCore = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = "ririying-finance-v1";
  const MAX_CENTS = 100000000000; // 10 亿元，防止误输入
  const MAX_CHANGE_LOG = 3000;

  const STATUS = {
    confirmed: "已确认",
    estimated: "估算",
    pending: "待确认"
  };

  const ASSET_CATEGORIES = [
    {
      key: "cash",
      label: "货币资金",
      hint: "已经到账、可以直接使用的钱。",
      subtypes: [
        { key: "bank_card", label: "银行卡余额" },
        { key: "cash_on_hand", label: "店内现金" },
        { key: "wechat", label: "微信余额" },
        { key: "alipay", label: "支付宝余额" },
        { key: "other_account", label: "其他账户资金" }
      ]
    },
    {
      key: "settlement",
      label: "待结算资金",
      hint: "平台还没打到银行卡的钱。到账后请点「到账」转入货币资金，避免重复统计。",
      subtypes: [
        { key: "sqb", label: "收钱吧待结算" },
        { key: "meituan", label: "美团待结算" },
        { key: "douyin", label: "抖音待结算" },
        { key: "other_platform", label: "其他平台待结算" }
      ]
    },
    {
      key: "inventory",
      label: "存货资产",
      hint: "库存按估值记录，默认标为估算值，可随时手动调整。",
      subtypes: [
        { key: "raw", label: "原材料库存", defaultStatus: "estimated" },
        { key: "packaging", label: "包装材料库存", defaultStatus: "estimated" },
        { key: "other_inventory", label: "其他库存", defaultStatus: "estimated" }
      ]
    },
    {
      key: "prepaid",
      label: "预付费用",
      hint: "只记录尚未使用的部分；已经用掉的部分属于费用，不再算资产。",
      subtypes: [
        { key: "prepaid_rent", label: "预付房租", period: true },
        { key: "prepaid_utilities", label: "预付水电费", period: true },
        { key: "other_prepaid", label: "其他预付费用", period: true }
      ]
    },
    {
      key: "recoverable",
      label: "可回收资产",
      hint: "押金按预计能收回的金额记录，而不是默认全额。",
      subtypes: [
        { key: "lease_deposit", label: "租赁押金", deposit: true, defaultStatus: "estimated" },
        { key: "equipment", label: "设备及其他可回收资产", defaultStatus: "estimated" },
        { key: "receivable", label: "应收账款" },
        { key: "other_asset", label: "其他资产" }
      ]
    }
  ];

  const LIABILITY_CATEGORIES = [
    {
      key: "payable",
      label: "应付账款",
      hint: "还没付给供应商的钱。已付清的请标记为已支付，不再计入。",
      subtypes: [
        { key: "supplier", label: "供应商货款" },
        { key: "other_purchase", label: "其他采购欠款" }
      ]
    },
    {
      key: "labor",
      label: "人工成本及应付工资",
      hint: "只记录已经干完活、还没付的工资；未来月份的工资不算当前负债。",
      subtypes: [
        { key: "owner_labor", label: "老板未支付的劳动报酬" },
        { key: "staff_wage", label: "员工工资" },
        { key: "other_labor", label: "其他人工费用" }
      ]
    },
    {
      key: "member",
      label: "会员储值及预收款",
      hint: "顾客已经付钱、门店还没提供的商品或服务。",
      subtypes: [{ key: "other_prepaid_revenue", label: "其他预收款或未履行权益" }]
    },
    {
      key: "other",
      label: "其他负债",
      hint: "已经发生、还没付的费用。未来才会发生的房租水电不算当前负债。",
      subtypes: [
        { key: "unpaid_utilities", label: "未支付的水电费", period: true },
        { key: "unpaid_rent", label: "未支付的房租", period: true },
        { key: "other_payable", label: "其他应付款" }
      ]
    }
  ];

  const MEMBER_BASIS = {
    full: "全额口径：实际充值 + 赠送余额都按负债计",
    paid_only: "仅实际充值口径：只把实际充值余额计为负债，赠送余额不计"
  };

  /* ---------------- 金额 ---------------- */

  function parseMoney(input) {
    if (typeof input === "number") {
      input = String(input);
    }
    const raw = String(input == null ? "" : input)
      .trim()
      .replace(/[¥￥元,，\s]/g, "")
      .replace(/。/g, ".");
    if (raw === "") {
      return { ok: false, empty: true, error: "请输入金额" };
    }
    if (/^[-−]/.test(raw)) {
      return { ok: false, error: "金额不能为负数" };
    }
    const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(raw);
    if (!match) {
      if (/^\d+\.\d{3,}$/.test(raw)) {
        return { ok: false, error: "金额最多精确到分（两位小数）" };
      }
      return { ok: false, error: "金额格式不正确，只能输入数字和小数点" };
    }
    const yuan = match[1].replace(/^0+(?=\d)/, "");
    const fen = (match[2] || "").padEnd(2, "0");
    if (yuan.length > 12) {
      return { ok: false, error: "金额过大，请检查" };
    }
    const cents = Number(yuan) * 100 + Number(fen);
    if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) {
      return { ok: false, error: "金额过大，请检查" };
    }
    return { ok: true, cents };
  }

  function formatMoney(cents, opts) {
    const options = opts || {};
    if (cents == null || !Number.isFinite(cents)) {
      return options.unknown || "未知";
    }
    const negative = cents < 0;
    const abs = Math.abs(Math.round(cents));
    const yuan = Math.floor(abs / 100);
    const fen = String(abs % 100).padStart(2, "0");
    const grouped = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const sign = negative ? "-" : options.signed && abs > 0 ? "+" : "";
    return `${sign}¥${grouped}.${fen}`;
  }

  function centsToInput(cents) {
    if (cents == null) {
      return "";
    }
    return (cents / 100).toFixed(2);
  }

  /* ---------------- 分类 ---------------- */

  function categoriesFor(kind) {
    return kind === "asset" ? ASSET_CATEGORIES : LIABILITY_CATEGORIES;
  }

  function findCategory(kind, key) {
    return categoriesFor(kind).find((c) => c.key === key) || null;
  }

  function findSubtype(kind, subtypeKey) {
    for (const category of categoriesFor(kind)) {
      const subtype = category.subtypes.find((s) => s.key === subtypeKey);
      if (subtype) {
        return { category, subtype };
      }
    }
    return null;
  }

  /* ---------------- 状态 ---------------- */

  function createEmptyMemberDeposit() {
    return {
      enabled: false,
      systemTotalCents: null,
      composition: "unknown",
      paidCents: null,
      bonusCents: null,
      basis: "full",
      estimateCents: null,
      rule: "",
      note: "",
      updatedAt: null
    };
  }

  function createEmptyState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      storeName: "",
      assets: [],
      liabilities: [],
      memberDeposit: createEmptyMemberDeposit(),
      snapshots: [],
      changeLog: [],
      updatedAt: null
    };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeState(raw) {
    const base = createEmptyState();
    if (!raw || typeof raw !== "object") {
      return base;
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      storeName: typeof raw.storeName === "string" ? raw.storeName : "",
      assets: Array.isArray(raw.assets) ? raw.assets : [],
      liabilities: Array.isArray(raw.liabilities) ? raw.liabilities : [],
      memberDeposit: Object.assign(createEmptyMemberDeposit(), raw.memberDeposit || {}),
      snapshots: Array.isArray(raw.snapshots) ? raw.snapshots : [],
      changeLog: Array.isArray(raw.changeLog) ? raw.changeLog : [],
      updatedAt: raw.updatedAt || null
    };
  }

  function loadState(storage) {
    try {
      const saved = storage.getItem(STORAGE_KEY);
      if (!saved) {
        return { state: createEmptyState(), fresh: true };
      }
      return { state: normalizeState(JSON.parse(saved)), fresh: false };
    } catch (error) {
      // 数据损坏时保留一份原始数据，避免被覆盖后无法找回
      try {
        const broken = storage.getItem(STORAGE_KEY);
        if (broken) {
          storage.setItem(`${STORAGE_KEY}-broken-${Date.now()}`, broken);
        }
      } catch (ignored) {
        /* noop */
      }
      return { state: createEmptyState(), fresh: true, error: "本机财务数据读取失败，已备份原数据" };
    }
  }

  function saveState(storage, state) {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  let idCounter = 0;
  function newId(prefix) {
    idCounter += 1;
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}${idCounter}`;
  }

  /* ---------------- 校验 ---------------- */

  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

  function todayString(now) {
    const d = now ? new Date(now) : new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function periodsOverlap(a, b) {
    if (!a.periodStart || !a.periodEnd || !b.periodStart || !b.periodEnd) {
      return false;
    }
    return a.periodStart <= b.periodEnd && b.periodStart <= a.periodEnd;
  }

  function isCounted(kind, item) {
    if (item.status === "pending" || item.amountCents == null) {
      return false;
    }
    if (kind === "liability" && item.paid) {
      return false;
    }
    return true;
  }

  /**
   * 校验一个资产或负债项目。
   * 返回 errors（必须修正）和 warnings（需要用户确认后才能保存）。
   */
  function validateItem(kind, item, state, now) {
    const errors = [];
    const warnings = [];
    const found = findSubtype(kind, item.subtype);
    if (!found) {
      errors.push("请选择项目类型");
      return { errors, warnings };
    }
    const { subtype } = found;

    if (!item.name || !String(item.name).trim()) {
      errors.push("请填写项目名称");
    }
    if (!STATUS[item.status]) {
      errors.push("请选择数据状态");
    }

    if (item.amountCents == null) {
      if (item.status !== "pending") {
        errors.push("金额未知时请把状态设为「待确认」，不会按 0 计入");
      }
    } else if (!Number.isSafeInteger(item.amountCents) || item.amountCents < 0) {
      errors.push("金额必须是不小于 0 的数字");
    } else if (item.amountCents > MAX_CENTS) {
      errors.push("金额过大，请检查");
    }

    if (subtype.deposit && item.faceCents != null && item.amountCents != null) {
      if (item.amountCents > item.faceCents) {
        errors.push("预计可收回金额不能大于押金原额");
      }
    }

    if (subtype.period) {
      const hasStart = !!item.periodStart;
      const hasEnd = !!item.periodEnd;
      if (hasStart !== hasEnd) {
        errors.push("覆盖期间请同时填写开始月和结束月");
      } else if (hasStart) {
        if (!MONTH_RE.test(item.periodStart) || !MONTH_RE.test(item.periodEnd)) {
          errors.push("覆盖期间格式应为 年-月");
        } else if (item.periodStart > item.periodEnd) {
          errors.push("覆盖期间的开始月不能晚于结束月");
        }
      }
    }

    if (kind === "liability") {
      const today = todayString(now);
      if (!item.incurredDate || !DATE_RE.test(item.incurredDate)) {
        errors.push("请填写发生日期");
      } else if (item.incurredDate > today) {
        errors.push("发生日期在未来：尚未发生的工资、房租等不能列为当前负债");
      }
      if (item.dueDate) {
        if (!DATE_RE.test(item.dueDate)) {
          errors.push("应付日期格式不正确");
        } else if (item.incurredDate && item.dueDate < item.incurredDate) {
          errors.push("应付日期不能早于发生日期");
        }
      }
    }

    // 预付房租（资产）与未付房租（负债）同一期间不能同时存在
    if (state && !errors.length) {
      const rentPairs = { prepaid_rent: "unpaid_rent", unpaid_rent: "prepaid_rent" };
      const utilPairs = { prepaid_utilities: "unpaid_utilities", unpaid_utilities: "prepaid_utilities" };
      const pairs = Object.assign({}, rentPairs, utilPairs);
      const counterpart = pairs[item.subtype];
      if (counterpart) {
        const otherList = kind === "asset" ? state.liabilities : state.assets;
        const otherKind = kind === "asset" ? "liability" : "asset";
        const conflict = otherList.find(
          (other) =>
            other.subtype === counterpart &&
            isCounted(otherKind, other) &&
            periodsOverlap(item, other)
        );
        if (conflict && isCounted(kind, item)) {
          const label = item.subtype.includes("rent") ? "房租" : "水电费";
          errors.push(
            `同一期间的${label}不能同时记为预付（资产）和未付（负债）：与「${conflict.name}」的期间重叠`
          );
        }
      }

      // 重复记录检查：同类型、同金额、同发生日期
      if (kind === "liability" && item.amountCents != null) {
        const duplicate = state.liabilities.find(
          (other) =>
            other.id !== item.id &&
            other.subtype === item.subtype &&
            other.amountCents === item.amountCents &&
            other.incurredDate === item.incurredDate
        );
        if (duplicate) {
          warnings.push(
            duplicate.paid
              ? `「${duplicate.name}」已作为已支付记录存在（同类型、同金额、同日期）。同一笔费用不能既算已支付又算未支付`
              : `与「${duplicate.name}」类型、金额、发生日期都相同，可能是重复记录`
          );
        }
      }
    }

    return { errors, warnings };
  }

  function validateMemberDeposit(md) {
    const errors = [];
    if (!md.enabled) {
      return { errors };
    }
    if (md.systemTotalCents == null) {
      errors.push("请填写会员系统显示的总未核销余额");
    }
    if (md.composition === "split") {
      if (md.paidCents == null || md.bonusCents == null) {
        errors.push("已拆分时请填写实际充值余额和赠送余额");
      } else if (md.systemTotalCents != null && md.paidCents + md.bonusCents !== md.systemTotalCents) {
        errors.push(
          `实际充值余额 + 赠送余额 = ${formatMoney(md.paidCents + md.bonusCents)}，与系统总余额 ${formatMoney(
            md.systemTotalCents
          )} 不一致`
        );
      }
      if (!MEMBER_BASIS[md.basis]) {
        errors.push("请选择会员余额的负债口径");
      }
    } else if (md.composition === "unknown") {
      if (md.estimateCents != null && md.systemTotalCents != null && md.estimateCents > md.systemTotalCents) {
        errors.push("暂估负债金额不能超过系统总未核销余额");
      }
    } else {
      errors.push("请选择余额构成");
    }
    return { errors };
  }

  /* ---------------- 会员储值 ---------------- */

  /**
   * 根据当前口径计算会员储值计入的负债。
   * 绝不使用活动比例（如 充300送30）倒推实际充值金额。
   */
  function computeMember(md) {
    const empty = {
      enabled: false,
      liabilityCents: 0,
      counted: false,
      flag: null,
      pendingCents: 0,
      basisLabel: "未录入会员储值",
      scenarios: []
    };
    if (!md || !md.enabled || md.systemTotalCents == null) {
      return empty;
    }
    const total = md.systemTotalCents;
    if (md.composition === "split" && md.paidCents != null && md.bonusCents != null) {
      const full = md.paidCents + md.bonusCents;
      const paidOnly = md.paidCents;
      const liability = md.basis === "paid_only" ? paidOnly : full;
      return {
        enabled: true,
        liabilityCents: liability,
        counted: true,
        flag: "confirmed",
        pendingCents: 0,
        basisLabel: MEMBER_BASIS[md.basis] || MEMBER_BASIS.full,
        scenarios: [
          { key: "full", label: "全额口径（含赠送）", liabilityCents: full, current: md.basis !== "paid_only" },
          { key: "paid_only", label: "仅实际充值口径", liabilityCents: paidOnly, current: md.basis === "paid_only" }
        ]
      };
    }
    // 余额构成未知
    const scenarios = [
      { key: "full", label: "全额口径（总余额全部计负债，最保守）", liabilityCents: total, current: false }
    ];
    if (md.estimateCents != null) {
      scenarios.push({
        key: "estimate",
        label: "用户暂估口径",
        liabilityCents: md.estimateCents,
        current: true
      });
      scenarios.push({ key: "excluded", label: "暂不计入", liabilityCents: 0, current: false });
      return {
        enabled: true,
        liabilityCents: md.estimateCents,
        counted: true,
        flag: "estimated",
        pendingCents: 0,
        basisLabel: `余额构成未知，按用户暂估 ${formatMoney(md.estimateCents)} 计入负债（暂估值）`,
        scenarios
      };
    }
    scenarios.push({ key: "excluded", label: "暂不计入（当前）", liabilityCents: 0, current: true });
    return {
      enabled: true,
      liabilityCents: 0,
      counted: false,
      flag: "pending",
      pendingCents: total,
      basisLabel: "余额构成未知，未填暂估值：会员余额暂列为待确认，未计入正式负债",
      scenarios
    };
  }

  /* ---------------- 汇总计算 ---------------- */

  function sumBy(list, kind) {
    return list.reduce((sum, item) => (isCounted(kind, item) ? sum + item.amountCents : sum), 0);
  }

  function computeTotals(state) {
    const assetCats = ASSET_CATEGORIES.map((cat) => {
      const items = state.assets.filter((i) => findSubtype("asset", i.subtype)?.category.key === cat.key);
      return { key: cat.key, label: cat.label, totalCents: sumBy(items, "asset"), count: items.length };
    });
    const member = computeMember(state.memberDeposit);
    const liabCats = LIABILITY_CATEGORIES.map((cat) => {
      const items = state.liabilities.filter(
        (i) => findSubtype("liability", i.subtype)?.category.key === cat.key
      );
      let total = sumBy(items, "liability");
      if (cat.key === "member") {
        total += member.liabilityCents;
      }
      return { key: cat.key, label: cat.label, totalCents: total, count: items.length };
    });

    const assetsCents = assetCats.reduce((s, c) => s + c.totalCents, 0);
    const liabilitiesCents = liabCats.reduce((s, c) => s + c.totalCents, 0);
    const share = (part, whole) => (whole > 0 ? part / whole : 0);
    assetCats.forEach((c) => (c.share = share(c.totalCents, assetsCents)));
    liabCats.forEach((c) => (c.share = share(c.totalCents, liabilitiesCents)));

    const pendingAssetItems = state.assets.filter((i) => i.status === "pending");
    const pendingLiabItems = state.liabilities.filter((i) => i.status === "pending" && !i.paid);
    const pendingAssetsCents = pendingAssetItems.reduce((s, i) => s + (i.amountCents || 0), 0);
    const pendingLiabilitiesCents =
      pendingLiabItems.reduce((s, i) => s + (i.amountCents || 0), 0) + member.pendingCents;
    const unknownAmountCount =
      pendingAssetItems.filter((i) => i.amountCents == null).length +
      pendingLiabItems.filter((i) => i.amountCents == null).length;

    const estimatedAssets = state.assets.filter((i) => i.status === "estimated" && isCounted("asset", i));
    const estimatedLiabs = state.liabilities.filter(
      (i) => i.status === "estimated" && isCounted("liability", i)
    );
    const estimatedCents =
      estimatedAssets.reduce((s, i) => s + i.amountCents, 0) +
      estimatedLiabs.reduce((s, i) => s + i.amountCents, 0) +
      (member.flag === "estimated" ? member.liabilityCents : 0);

    const netCents = assetsCents - liabilitiesCents;
    const netWithoutMember = netCents + member.liabilityCents;
    const memberScenarios = member.scenarios.map((s) => ({
      key: s.key,
      label: s.label,
      current: s.current,
      liabilityCents: s.liabilityCents,
      netCents: netWithoutMember - s.liabilityCents,
      diffFromCurrentCents: member.liabilityCents - s.liabilityCents
    }));

    return {
      assetsCents,
      liabilitiesCents,
      netCents,
      pendingAssetsCents,
      pendingLiabilitiesCents,
      pendingTotalCents: pendingAssetsCents + pendingLiabilitiesCents,
      pendingCount: pendingAssetItems.length + pendingLiabItems.length + (member.flag === "pending" ? 1 : 0),
      unknownAmountCount,
      estimatedCount: estimatedAssets.length + estimatedLiabs.length + (member.flag === "estimated" ? 1 : 0),
      estimatedCents,
      paidCount: state.liabilities.filter((i) => i.paid).length,
      assetCategories: assetCats,
      liabilityCategories: liabCats,
      member,
      memberScenarios
    };
  }

  /* ---------------- 提示 ---------------- */

  function buildHints(state, totals) {
    const hints = [];
    const hasData = state.assets.length || state.liabilities.length || state.memberDeposit.enabled;
    if (!hasData) {
      hints.push({ level: "info", text: "还没有录入数据。先从银行卡、现金和平台待结算开始。" });
      return hints;
    }
    if (totals.netCents > 0) {
      hints.push({
        level: "good",
        text: `净资产为正（${formatMoney(totals.netCents)}）：按当前录入的数据，资产足以覆盖负债和未履行义务。`
      });
    } else if (totals.netCents < 0) {
      hints.push({
        level: "warn",
        text: `净资产为负（${formatMoney(totals.netCents)}）：按当前录入的数据，负债和未履行义务超过资产 ${formatMoney(
          -totals.netCents
        )}。`
      });
    } else {
      hints.push({ level: "info", text: "净资产为 0：资产与负债相等。" });
    }
    hints.push({
      level: "info",
      text: "净资产是此刻的家底（资产 − 负债），不等于累计经营利润或亏损，不能单凭它判断门店是否赚钱。"
    });
    if (totals.pendingCount > 0) {
      const parts = [];
      if (totals.pendingAssetsCents) parts.push(`资产 ${formatMoney(totals.pendingAssetsCents)}`);
      if (totals.pendingLiabilitiesCents) parts.push(`负债 ${formatMoney(totals.pendingLiabilitiesCents)}`);
      if (totals.unknownAmountCount) parts.push(`${totals.unknownAmountCount} 项金额未知`);
      hints.push({
        level: "warn",
        text: `存在 ${totals.pendingCount} 个待确认项目（${parts.join("，") || "金额未知"}），尚未计入正式结果。`
      });
    }
    if (totals.estimatedCount > 0) {
      hints.push({
        level: "warn",
        text: `有 ${totals.estimatedCount} 项为估算值（合计 ${formatMoney(totals.estimatedCents)}），实际金额可能不同。`
      });
    }
    const md = state.memberDeposit;
    if (md.enabled && md.composition !== "split") {
      hints.push({
        level: "warn",
        text: "会员余额尚未拆分实际充值金额与赠送金额，当前口径见「会员储值核算」。"
      });
    }
    const hasSettlement = state.assets.some(
      (i) => findSubtype("asset", i.subtype)?.category.key === "settlement" && isCounted("asset", i) && i.amountCents > 0
    );
    if (hasSettlement) {
      hints.push({
        level: "info",
        text: "平台待结算资金到账后，请在对应项目点「到账」转入银行卡，不要直接改银行卡余额，以免重复统计。"
      });
    }
    const rentAsset = state.assets.some((i) => i.subtype === "prepaid_rent" && isCounted("asset", i));
    const rentLiab = state.liabilities.some((i) => i.subtype === "unpaid_rent" && isCounted("liability", i));
    const missingPeriod = [...state.assets, ...state.liabilities].some(
      (i) => (i.subtype === "prepaid_rent" || i.subtype === "unpaid_rent") && !i.periodStart
    );
    if (rentAsset && rentLiab && missingPeriod) {
      hints.push({
        level: "warn",
        text: "同时存在预付房租和未付房租，但有项目未填覆盖期间，无法自动检查是否重复，请补充期间。"
      });
    }
    return hints;
  }

  /* ---------------- 变化记录 ---------------- */

  function logChange(state, entry) {
    state.changeLog.push(Object.assign({ at: Date.now() }, entry));
    if (state.changeLog.length > MAX_CHANGE_LOG) {
      state.changeLog.splice(0, state.changeLog.length - MAX_CHANGE_LOG);
    }
  }

  function listFor(state, kind) {
    return kind === "asset" ? state.assets : state.liabilities;
  }

  /** 新增或更新项目，返回新的 state（不修改传入对象）。 */
  function upsertItem(state, kind, input, now) {
    const at = now || Date.now();
    const next = clone(state);
    const list = listFor(next, kind);
    const index = input.id ? list.findIndex((i) => i.id === input.id) : -1;
    const item = Object.assign({}, input, { updatedAt: at });
    if (index === -1) {
      item.id = item.id || newId(kind === "asset" ? "a" : "l");
      item.createdAt = at;
      list.push(item);
      logChange(next, {
        at,
        kind,
        itemId: item.id,
        name: item.name,
        action: "create",
        fromCents: null,
        toCents: item.amountCents,
        status: item.status
      });
    } else {
      const before = list[index];
      item.createdAt = before.createdAt;
      list[index] = item;
      const changed =
        before.amountCents !== item.amountCents ||
        before.status !== item.status ||
        !!before.paid !== !!item.paid;
      if (changed) {
        logChange(next, {
          at,
          kind,
          itemId: item.id,
          name: item.name,
          action: before.paid !== item.paid && item.paid ? "paid" : "update",
          fromCents: before.amountCents,
          toCents: item.amountCents,
          status: item.status
        });
      }
    }
    next.updatedAt = at;
    return { state: next, item };
  }

  function deleteItem(state, kind, id, now) {
    const at = now || Date.now();
    const next = clone(state);
    const list = listFor(next, kind);
    const index = list.findIndex((i) => i.id === id);
    if (index === -1) {
      return { state: next, removed: null };
    }
    const [removed] = list.splice(index, 1);
    logChange(next, {
      at,
      kind,
      itemId: id,
      name: removed.name,
      action: "delete",
      fromCents: removed.amountCents,
      toCents: null
    });
    next.updatedAt = at;
    return { state: next, removed };
  }

  /**
   * 平台结算款到账：从待结算项目减少，同时增加到货币资金项目。
   * 资产总额不变，避免「已到账」和「待结算」重复统计。
   */
  function transferSettlement(state, settlementId, cashId, cents, now) {
    const at = now || Date.now();
    const settlement = state.assets.find((i) => i.id === settlementId);
    const cash = state.assets.find((i) => i.id === cashId);
    if (!settlement || findSubtype("asset", settlement.subtype)?.category.key !== "settlement") {
      return { error: "找不到对应的待结算项目" };
    }
    if (!cash || findSubtype("asset", cash.subtype)?.category.key !== "cash") {
      return { error: "请选择到账的货币资金账户" };
    }
    if (settlement.amountCents == null || settlement.status === "pending") {
      return { error: "待结算金额尚未确认，请先确认金额" };
    }
    if (cash.amountCents == null || cash.status === "pending") {
      return { error: "到账账户的余额尚未确认，请先确认余额" };
    }
    if (!Number.isSafeInteger(cents) || cents <= 0) {
      return { error: "到账金额必须大于 0" };
    }
    if (cents > settlement.amountCents) {
      return { error: `到账金额不能超过待结算金额 ${formatMoney(settlement.amountCents)}` };
    }
    const next = clone(state);
    const s = next.assets.find((i) => i.id === settlementId);
    const c = next.assets.find((i) => i.id === cashId);
    const sBefore = s.amountCents;
    const cBefore = c.amountCents;
    s.amountCents -= cents;
    c.amountCents += cents;
    s.updatedAt = at;
    c.updatedAt = at;
    logChange(next, {
      at,
      kind: "asset",
      itemId: s.id,
      name: s.name,
      action: "transfer_out",
      fromCents: sBefore,
      toCents: s.amountCents,
      memo: `到账 ${formatMoney(cents)} 转入「${c.name}」`
    });
    logChange(next, {
      at,
      kind: "asset",
      itemId: c.id,
      name: c.name,
      action: "transfer_in",
      fromCents: cBefore,
      toCents: c.amountCents,
      memo: `来自「${s.name}」到账 ${formatMoney(cents)}`
    });
    next.updatedAt = at;
    return { state: next };
  }

  function updateMemberDeposit(state, md, now) {
    const at = now || Date.now();
    const next = clone(state);
    const beforeLiab = computeMember(state.memberDeposit).liabilityCents;
    next.memberDeposit = Object.assign(createEmptyMemberDeposit(), md, { updatedAt: at });
    const after = computeMember(next.memberDeposit);
    logChange(next, {
      at,
      kind: "liability",
      itemId: "member_deposit",
      name: "会员储值余额",
      action: "update",
      fromCents: beforeLiab,
      toCents: after.liabilityCents,
      memo: after.basisLabel
    });
    next.updatedAt = at;
    return next;
  }

  function changesForItem(state, itemId) {
    return state.changeLog.filter((e) => e.itemId === itemId).slice().reverse();
  }

  /* ---------------- 历史盘点快照 ---------------- */

  function createSnapshot(state, opts, now) {
    const options = opts || {};
    const at = now || Date.now();
    const totals = computeTotals(state);
    const describe = (kind) => (item) => ({
      id: item.id,
      name: item.name,
      subtype: item.subtype,
      category: findSubtype(kind, item.subtype)?.category.key || null,
      amountCents: item.amountCents,
      status: item.status,
      paid: !!item.paid,
      counted: isCounted(kind, item)
    });
    return {
      id: newId("s"),
      takenAt: at,
      date: options.date || todayString(at),
      note: options.note || "",
      storeName: state.storeName,
      assets: clone(state.assets),
      liabilities: clone(state.liabilities),
      memberDeposit: clone(state.memberDeposit),
      totals: {
        assetsCents: totals.assetsCents,
        liabilitiesCents: totals.liabilitiesCents,
        netCents: totals.netCents,
        pendingAssetsCents: totals.pendingAssetsCents,
        pendingLiabilitiesCents: totals.pendingLiabilitiesCents,
        estimatedCents: totals.estimatedCents,
        assetCategories: totals.assetCategories.map((c) => ({ key: c.key, label: c.label, totalCents: c.totalCents })),
        liabilityCategories: totals.liabilityCategories.map((c) => ({
          key: c.key,
          label: c.label,
          totalCents: c.totalCents
        }))
      },
      estimatedItems: [
        ...state.assets.filter((i) => i.status === "estimated").map(describe("asset")),
        ...state.liabilities.filter((i) => i.status === "estimated").map(describe("liability"))
      ],
      pendingItems: [
        ...state.assets.filter((i) => i.status === "pending").map(describe("asset")),
        ...state.liabilities.filter((i) => i.status === "pending").map(describe("liability"))
      ],
      basis: {
        member: totals.member.basisLabel,
        memberLiabilityCents: totals.member.liabilityCents,
        rules: [
          "净资产 = 资产总额 − 负债总额",
          "待确认项目不计入正式结果",
          "已支付的负债不计入",
          "金额单位：人民币分"
        ]
      }
    };
  }

  function addSnapshot(state, opts, now) {
    const next = clone(state);
    const snapshot = createSnapshot(state, opts, now);
    next.snapshots.push(snapshot);
    next.snapshots.sort((a, b) => (a.date === b.date ? a.takenAt - b.takenAt : a.date < b.date ? -1 : 1));
    return { state: next, snapshot };
  }

  function deleteSnapshot(state, id) {
    const next = clone(state);
    next.snapshots = next.snapshots.filter((s) => s.id !== id);
    return next;
  }

  function latestSnapshot(state) {
    return state.snapshots.length ? state.snapshots[state.snapshots.length - 1] : null;
  }

  /** 比较两份盘点（from → to）。to 也可以是当前数据生成的临时快照。 */
  function compareSnapshots(from, to) {
    const diff = (a, b) => b - a;
    const catDiff = (fromCats, toCats) =>
      toCats.map((c) => {
        const prev = fromCats.find((p) => p.key === c.key);
        const prevCents = prev ? prev.totalCents : 0;
        return { key: c.key, label: c.label, fromCents: prevCents, toCents: c.totalCents, diffCents: c.totalCents - prevCents };
      });
    const itemDiff = (fromItems, toItems) => {
      const rows = [];
      const seen = new Set();
      toItems.forEach((item) => {
        const prev = fromItems.find((p) => p.id === item.id);
        seen.add(item.id);
        const before = prev ? prev.amountCents : null;
        if (!prev || before !== item.amountCents || prev.status !== item.status || !!prev.paid !== !!item.paid) {
          rows.push({ id: item.id, name: item.name, fromCents: before, toCents: item.amountCents, change: prev ? "changed" : "added" });
        }
      });
      fromItems.forEach((prev) => {
        if (!seen.has(prev.id)) {
          rows.push({ id: prev.id, name: prev.name, fromCents: prev.amountCents, toCents: null, change: "removed" });
        }
      });
      return rows;
    };
    return {
      from: { date: from.date, takenAt: from.takenAt },
      to: { date: to.date, takenAt: to.takenAt },
      assetsDiffCents: diff(from.totals.assetsCents, to.totals.assetsCents),
      liabilitiesDiffCents: diff(from.totals.liabilitiesCents, to.totals.liabilitiesCents),
      netDiffCents: diff(from.totals.netCents, to.totals.netCents),
      assetCategories: catDiff(from.totals.assetCategories, to.totals.assetCategories),
      liabilityCategories: catDiff(from.totals.liabilityCategories, to.totals.liabilityCategories),
      assetItems: itemDiff(from.assets, to.assets),
      liabilityItems: itemDiff(from.liabilities, to.liabilities),
      basisChanged: from.basis.member !== to.basis.member,
      fromBasis: from.basis.member,
      toBasis: to.basis.member
    };
  }

  /** 预付费用辅助：按已付总额和已使用月数计算尚未使用的部分。 */
  function unusedPrepaid(totalCents, months, usedMonths) {
    if (!Number.isSafeInteger(totalCents) || totalCents < 0) return { error: "已付总额不正确" };
    if (!Number.isInteger(months) || months <= 0) return { error: "覆盖月数必须大于 0" };
    if (!Number.isInteger(usedMonths) || usedMonths < 0) return { error: "已使用月数不正确" };
    if (usedMonths > months) return { error: "已使用月数不能超过覆盖月数" };
    // 按月平均分摊，余数放在最后一个月，保证分毫不差
    const perMonth = Math.floor(totalCents / months);
    const used = usedMonths === months ? totalCents : perMonth * usedMonths;
    return { cents: totalCents - used };
  }

  return {
    SCHEMA_VERSION,
    STORAGE_KEY,
    STATUS,
    ASSET_CATEGORIES,
    LIABILITY_CATEGORIES,
    MEMBER_BASIS,
    parseMoney,
    formatMoney,
    centsToInput,
    categoriesFor,
    findCategory,
    findSubtype,
    createEmptyState,
    createEmptyMemberDeposit,
    normalizeState,
    loadState,
    saveState,
    todayString,
    isCounted,
    validateItem,
    validateMemberDeposit,
    computeMember,
    computeTotals,
    buildHints,
    upsertItem,
    deleteItem,
    transferSettlement,
    updateMemberDeposit,
    changesForItem,
    createSnapshot,
    addSnapshot,
    deleteSnapshot,
    latestSnapshot,
    compareSnapshots,
    unusedPrepaid
  };
});
