# 门店财务状况 · 测试

- 计算核心单元测试（无需依赖）：`node --test tests/*.test.js`
- 浏览器端到端验收（需要 Playwright 和 Chromium）：`node tests/finance-e2e.js`
  - 覆盖需求「八、验收标准」1–9 条：资产/负债/净资产计算、编辑删除、刷新后数据仍在、历史快照保存/查看/比较、平台到账不重复、预付与未付房租不重复、会员余额构成未知时不倒推。
  - 截图默认输出到 `tests/screenshots/`（已在 .gitignore 中忽略），可用 `SHOT_DIR` 改路径。
