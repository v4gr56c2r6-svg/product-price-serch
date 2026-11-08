"use strict";

const VAULT_KEY = "zekkyo-sales-vault-v1";
const LEGACY_REPORTS_KEY = "zekkyo-sales-daily-v1";
const LEGACY_CATALOG_KEY = "zekkyo-sales-products-v1";
const VAULT_ITERATIONS = 600000;
const GROUP_ORDER = ["たい焼き・単品", "アイス", "箱入り"];
const VIEW_TITLES = {
  dashboard: "ダッシュボード",
  entry: "日報入力",
  monthly: "日別・月別集計",
  catalog: "商品・価格一覧"
};
const WEATHER_OPTIONS = ["晴れ", "くもり", "雨", "雪", "その他"];
const CROWD_OPTIONS = ["すいている", "ふつう", "混雑", "非常に混雑"];
let reports = [];
let catalog = [];
let vaultKey = null;
let vaultSalt = null;
let vaultIterations = VAULT_ITERATIONS;
let activeView = "dashboard";
let toastTimer;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const yen = (value) => `¥${Math.round(Number(value) || 0).toLocaleString("ja-JP")}`;
const numberText = (value) => (Number(value) || 0).toLocaleString("ja-JP");

function localDateISO(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function currentMonth() { return localDateISO().slice(0, 7); }

function loadReports() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_REPORTS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.date === "string") : [];
  } catch {
    return [];
  }
}

function loadCatalog() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_CATALOG_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((product) => product && typeof product.id === "string" && /^[a-zA-Z0-9_-]+$/.test(product.id) && typeof product.name === "string" && Number.isFinite(Number(product.price)) && Number(product.price) >= 0 && GROUP_ORDER.includes(product.group)).map((product) => ({ ...product, price: Math.round(Number(product.price)), kind: productKind(product.group) }));
  } catch {
    return [];
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveVaultKey(password, salt, iterations = VAULT_ITERATIONS) {
  if (!globalThis.crypto?.subtle) throw new Error("secure-context-required");
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function persistVault() {
  if (!vaultKey || !vaultSalt) { showToast("ロック中のため保存できません。"); return false; }
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify({ reports, products: catalog }));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, vaultKey, plain);
    const record = {
      version: 1,
      iterations: vaultIterations,
      salt: bytesToBase64(vaultSalt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encrypted))
    };
    localStorage.setItem(VAULT_KEY, JSON.stringify(record));
    return true;
  } catch {
    showToast("暗号化保存に失敗しました。ブラウザの空き容量を確認してください。");
    return false;
  }
}

async function decryptVaultRecord(record, password) {
  if (!record || record.version !== 1 || !Number.isInteger(record.iterations) || record.iterations < 100000 || record.iterations > 1000000) throw new Error("invalid-vault");
  const salt = base64ToBytes(record.salt);
  const iv = base64ToBytes(record.iv);
  const ciphertext = base64ToBytes(record.ciphertext);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) throw new Error("invalid-vault");
  const key = await deriveVaultKey(password, salt, record.iterations);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  const data = JSON.parse(new TextDecoder().decode(plaintext));
  if (!data || !Array.isArray(data.reports) || !Array.isArray(data.products)) throw new Error("invalid-payload");
  const cleanReports = data.reports.filter((report) => report && typeof report.date === "string");
  const cleanProducts = data.products.filter((product) => product && typeof product.id === "string" && /^[a-zA-Z0-9_-]+$/.test(product.id) && typeof product.name === "string" && Number.isFinite(Number(product.price)) && Number(product.price) >= 0 && GROUP_ORDER.includes(product.group)).map((product) => ({ ...product, price: Math.round(Number(product.price)), kind: productKind(product.group) }));
  return { key, salt, iterations: record.iterations, reports: cleanReports, catalog: cleanProducts };
}

function productKind(group) {
  return group === "アイス" ? "ice" : group === "箱入り" ? "box" : "single";
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function formatDate(dateString, options = { month: "numeric", day: "numeric", weekday: "short" }) {
  if (!dateString) return "—";
  const date = new Date(`${dateString}T12:00:00`);
  return new Intl.DateTimeFormat("ja-JP", options).format(date);
}

function monthReports(month) {
  return reports.filter((report) => report.date.startsWith(month)).sort((a, b) => a.date.localeCompare(b.date));
}

function reportTotals(list) {
  const sales = list.reduce((total, report) => total + (Number(report.sales) || 0), 0);
  const customers = list.reduce((total, report) => total + (Number(report.customers) || 0), 0);
  const quantities = list.reduce((total, report) => total + Object.values(report.items || {}).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0), 0);
  const ice = list.reduce((total, report) => total + itemQuantityByKind(report, "ice"), 0);
  const boxes = list.reduce((total, report) => total + itemQuantityByKind(report, "box"), 0);
  return { sales, customers, quantities, ice, boxes, days: list.length, ticket: customers ? sales / customers : 0 };
}

function productBreakdown(list) {
  const totals = new Map();
  list.forEach((report) => {
    Object.entries(report.items || {}).forEach(([id, savedItem]) => {
      const product = catalog.find((item) => item.id === id);
      const quantity = Number(savedItem.quantity) || 0;
      if (!quantity) return;
      const savedPrice = Number.isFinite(Number(savedItem.price)) ? Number(savedItem.price) : (product?.price ?? 0);
      const row = totals.get(id) || {
        name: savedItem.name || product?.name || id,
        group: product?.group || (savedItem.kind === "ice" ? "アイス" : savedItem.kind === "box" ? "箱入り" : "たい焼き・単品"),
        quantity: 0,
        amount: 0
      };
      row.quantity += quantity;
      row.amount += quantity * savedPrice;
      totals.set(id, row);
    });
  });
  return [...totals.entries()].map(([id, value]) => ({ id, ...value })).sort((a, b) => {
    const groupDifference = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    if (groupDifference) return groupDifference;
    const aIndex = catalog.findIndex((product) => product.id === a.id);
    const bIndex = catalog.findIndex((product) => product.id === b.id);
    return aIndex === -1 || bIndex === -1 ? a.name.localeCompare(b.name, "ja") : aIndex - bIndex;
  });
}

function itemQuantityByKind(report, kind) {
  return Object.values(report.items || {}).reduce((sum, item) => sum + (item.kind === kind ? Number(item.quantity) || 0 : 0), 0);
}

function activeMonth() { return $("#active-month").value || currentMonth(); }

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function setView(view) {
  activeView = VIEW_TITLES[view] ? view : "dashboard";
  $$("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === activeView));
  $("#page-title").textContent = VIEW_TITLES[activeView];
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function pageHeading(title, description, actions = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${actions}</div></div>`;
}

function metricCard(label, value, foot, icon, tone = "") {
  return `<article class="metric-card"><div class="metric-top"><span>${label}</span><span class="metric-icon ${tone}" aria-hidden="true">${icon}</span></div><div class="metric-value">${value}</div><div class="metric-foot">${foot}</div></article>`;
}

function renderDashboard() {
  const month = activeMonth();
  const list = monthReports(month);
  const totals = reportTotals(list);
  const monthLabel = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long" }).format(new Date(`${month}-01T12:00:00`));
  const metrics = [
    metricCard("今月の売上", yen(totals.sales), `${monthLabel}の合計`, "¥", "orange"),
    metricCard("来店客数", `${numberText(totals.customers)}<small class="metric-unit">人</small>`, `${totals.days}営業日を記録`, "♙"),
    metricCard("客単価", yen(totals.ticket), "売上 ÷ 客数", "↗", "orange"),
    metricCard("日報入力", `${totals.days}<small class="metric-unit">日</small>`, "今月の記録日数", "▤")
  ].join("");
  const recent = [...list].reverse().slice(0, 5);
  return `${pageHeading("おつかれさまです", `${monthLabel}の店舗状況を確認できます。`)}
    <section class="metric-grid">${metrics}</section>
    <section class="dashboard-grid">
      <article class="panel"><div class="panel-header"><div><h2>日別売上</h2><p>${monthLabel}の売上推移</p></div><span class="mini-badge">${totals.days}日記録</span></div><div class="panel-body chart-wrap">${chartSVG(list, month)}</div></article>
      <article class="panel"><div class="panel-header"><div><h2>月間サマリー</h2><p>記録済み日報から集計</p></div></div><div class="panel-body"><div class="summary-list">
        <div class="summary-row"><span class="summary-label">売上合計</span><strong class="summary-value">${yen(totals.sales)}</strong></div>
        <div class="summary-row"><span class="summary-label">客数合計</span><strong class="summary-value">${numberText(totals.customers)}人</strong></div>
        <div class="summary-row"><span class="summary-label">客単価</span><strong class="summary-value">${yen(totals.ticket)}</strong></div>
        <div class="summary-row"><span class="summary-label">商品販売数</span><strong class="summary-value">${numberText(totals.quantities)}点</strong></div>
        <div class="summary-row"><span class="summary-label">アイス / 箱入り</span><strong class="summary-value">${numberText(totals.ice)}点 / ${numberText(totals.boxes)}点</strong></div>
      </div></div></article>
    </section>
    <section class="panel recent-panel"><div class="panel-header"><div><h2>最近の日報</h2><p>最新5件</p></div><button class="text-button" data-view="monthly">日別一覧を見る →</button></div><div class="panel-body">${recent.length ? reportTable(recent, false) : `<div class="empty-state"><div><strong>まだ日報がありません</strong><p>最初の日報を入力すると、ここに表示されます。</p><button class="button button-primary button-compact" data-view="entry">＋ 日報を入力</button></div></div>`}</div></section>`;
}

function chartSVG(list, month) {
  if (!list.length) return `<div class="chart-empty"><div>日報を登録すると売上グラフが表示されます<span>日報入力から今日の記録を始めましょう</span></div></div>`;
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const values = Array.from({ length: daysInMonth }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, "0")}`;
    const report = list.find((item) => item.date === date);
    return { day: index + 1, sales: report ? Number(report.sales) || 0 : null };
  });
  const maxValue = Math.max(1, ...values.map((item) => item.sales || 0));
  const ticks = 4;
  const width = 720;
  const height = 230;
  const left = 48;
  const right = 12;
  const top = 16;
  const bottom = 27;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const step = chartWidth / daysInMonth;
  const barWidth = Math.max(3, Math.min(14, step * .56));
  const yTicks = Array.from({ length: ticks + 1 }, (_, index) => maxValue * (ticks - index) / ticks);
  const grids = yTicks.map((value) => {
    const y = top + (value / maxValue) * chartHeight;
    return `<line class="chart-grid" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="chart-label" text-anchor="end" x="${left - 8}" y="${y + 3}">${value >= 1000 ? `${Math.round(value / 1000)}k` : Math.round(value)}</text>`;
  }).join("");
  const bars = values.map((item, index) => {
    if (item.sales === null) return "";
    const barHeight = item.sales ? Math.max(3, item.sales / maxValue * chartHeight) : 0;
    const x = left + index * step + (step - barWidth) / 2;
    const y = top + chartHeight - barHeight;
    return `<rect class="chart-bar" x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="3"><title>${item.day}日: ${yen(item.sales)}</title></rect>`;
  }).join("");
  const labels = values.map((item) => {
    if (item.day !== 1 && item.day % 5 !== 0 && item.day !== daysInMonth) return "";
    const x = left + (item.day - .5) * step;
    return `<text class="chart-label" text-anchor="middle" x="${x}" y="${height - 5}">${item.day}</text>`;
  }).join("");
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(month)}の日別売上グラフ">${grids}${bars}${labels}</svg>`;
}

function menuProductChart(items, metric = "quantity") {
  if (!items.length) return `<div class="chart-empty"><div>商品別の販売記録はありません<span>日報入力でメニューごとの販売数を記録すると、グラフに表示されます</span></div></div>`;
  const isAmount = metric === "amount";
  const valueKey = isAmount ? "amount" : "quantity";
  const sortedItems = [...items].sort((a, b) => (Number(b[valueKey]) || 0) - (Number(a[valueKey]) || 0) || a.name.localeCompare(b.name, "ja"));
  const maxValue = Math.max(1, ...sortedItems.map((item) => Number(item[valueKey]) || 0));
  const rows = sortedItems.map((item) => {
    const value = Number(item[valueKey]) || 0;
    const width = value ? Math.max(1.5, value / maxValue * 100) : 0;
    const valueLabel = isAmount ? yen(value) : `${numberText(value)}点`;
    return `<div class="menu-chart-row${isAmount ? " is-amount" : ""}" role="listitem" aria-label="${escapeHTML(item.name)}: ${valueLabel}">
      <div class="menu-chart-product"><strong title="${escapeHTML(item.name)}">${escapeHTML(item.name)}</strong><span>${escapeHTML(item.group)}</span></div>
      <div class="menu-chart-track" aria-hidden="true"><span class="menu-chart-bar" style="width:${width.toFixed(2)}%"></span></div>
      <div class="menu-chart-value">${valueLabel}</div>
    </div>`;
  }).join("");
  const note = isAmount
    ? "参考金額は日報時点の商品価格 × 販売数です。レジ売上とは別集計です。"
    : "選択月の商品別販売数です。バーの長さは、最も販売数が多いメニューを基準にしています。";
  return `<div class="menu-chart-list" role="list" aria-label="${isAmount ? "商品別参考金額" : "商品別販売数"}">${rows}</div><p class="menu-chart-hint">${note}</p>`;
}

function reportTable(list, includeActions = true) {
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>営業日</th><th class="numeric">売上</th><th class="numeric">客数</th><th class="numeric">客単価</th><th>天気・気温</th><th>混雑</th>${includeActions ? "<th></th>" : ""}</tr></thead><tbody>${list.map((report) => {
    const ticket = report.customers ? Number(report.sales) / Number(report.customers) : 0;
    const weather = [report.weather, report.temperature !== "" && report.temperature != null ? `${report.temperature}℃` : ""].filter(Boolean).join(" · ") || "—";
    const actions = includeActions ? `<td><button class="text-button" data-edit-date="${report.date}">編集</button></td>` : "";
    return `<tr><td class="strong">${formatDate(report.date)}</td><td class="numeric strong">${yen(report.sales)}</td><td class="numeric">${numberText(report.customers)}人</td><td class="numeric">${yen(ticket)}</td><td>${escapeHTML(weather)}</td><td>${escapeHTML(report.crowding || "—")}</td>${actions}</tr>`;
  }).join("")}</tbody></table></div>`;
}

function reportCards(list) {
  return `<div class="report-list">${list.map((report) => {
    const totalQty = Object.values(report.items || {}).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    return `<article class="report-card"><div class="report-date">${formatDate(report.date)}<small>${report.weather || "天気未入力"}${report.temperature !== "" && report.temperature != null ? ` · ${report.temperature}℃` : ""}</small></div><div class="report-details"><span>売上 <strong>${yen(report.sales)}</strong></span><span>客数 <strong>${numberText(report.customers)}人</strong></span><span>客単価 <strong>${yen(report.customers ? report.sales / report.customers : 0)}</strong></span><span>商品 <strong>${numberText(totalQty)}点</strong></span></div><div class="report-actions"><button data-edit-date="${report.date}">編集</button></div></article>`;
  }).join("")}</div>`;
}

function renderMonthly() {
  const month = activeMonth();
  const list = monthReports(month);
  const totals = reportTotals(list);
  const monthLabel = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long" }).format(new Date(`${month}-01T12:00:00`));
  const metric = [
    metricCard("売上合計", yen(totals.sales), monthLabel, "¥", "orange"),
    metricCard("営業日数", `${totals.days}<small class="metric-unit">日</small>`, "入力済みの日報", "▤"),
    metricCard("客数合計", `${numberText(totals.customers)}<small class="metric-unit">人</small>`, "月間来店客数", "♙"),
    metricCard("平均客単価", yen(totals.ticket), "売上合計 ÷ 客数合計", "↗", "orange")
  ].join("");
  const tableContent = list.length ? reportCards([...list].reverse()) : `<div class="empty-state"><div><strong>この月の日報はありません</strong><p>日報を登録すると日別一覧に表示されます。</p><button class="button button-primary button-compact" data-view="entry">＋ 日報を入力</button></div></div>`;
  const breakdown = productBreakdown(list);
  const productContent = breakdown.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>商品</th><th class="numeric">販売数</th><th class="numeric">平均単価</th><th class="numeric">参考金額</th></tr></thead><tbody>${breakdown.map((item) => `<tr><td class="strong">${escapeHTML(item.name)}<span class="product-count"> · ${escapeHTML(item.group)}</span></td><td class="numeric">${numberText(item.quantity)}点</td><td class="numeric">${yen(item.quantity ? item.amount / item.quantity : 0)}</td><td class="numeric strong">${yen(item.amount)}</td></tr>`).join("")}</tbody></table></div><p class="table-scroll-hint">参考金額は日報時点の商品価格 × 販売数の合算です。レジ売上とは別集計です。</p>` : `<div class="empty-state"><div><strong>商品別の販売記録はありません</strong><p>日報入力で商品数を記録すると、ここに集計されます。</p></div></div>`;
  return `${pageHeading("日別・月別集計", `${monthLabel}の売上と営業記録を確認できます。`, `<button class="button button-secondary button-compact" id="export-csv">CSVを書き出す</button>`)}
    <section class="metric-grid">${metric}</section>
    <section class="panel"><div class="panel-header"><div><h2>月間売上推移</h2><p>売上を入力した営業日のみ表示</p></div><span class="mini-badge">${monthLabel}</span></div><div class="panel-body chart-wrap">${chartSVG(list, month)}</div></section>
    <section class="panel recent-panel"><div class="panel-header"><div><h2>メニュー別グラフ</h2><p>${monthLabel}のメニューごとの販売状況</p></div><span class="mini-badge">${breakdown.length}商品</span></div><div class="panel-body">
      <div class="menu-chart-toggle" role="group" aria-label="グラフ表示項目">
        <button type="button" class="menu-chart-toggle-button is-active" data-product-chart-mode="quantity" aria-pressed="true">販売数</button>
        <button type="button" class="menu-chart-toggle-button" data-product-chart-mode="amount" aria-pressed="false">参考金額</button>
      </div>
      <div id="menu-product-chart">${menuProductChart(breakdown)}</div>
    </div></section>
    <section class="panel recent-panel"><div class="panel-header"><div><h2>商品別の数値一覧</h2><p>${monthLabel}の商品数量と参考金額</p></div></div><div class="panel-body">${productContent}</div></section>
    <section class="panel recent-panel"><div class="panel-header"><div><h2>日別日報</h2><p>${list.length}件の記録</p></div></div><div class="panel-body">${tableContent}</div></section>`;
}

function fieldMarkup(id, label, type = "text", options = {}) {
  const required = options.required ? "required" : "";
  const optional = options.optional ? ` <span class="optional">任意</span>` : "";
  const placeholder = options.placeholder ? `placeholder="${escapeHTML(options.placeholder)}"` : "";
  const min = options.min != null ? `min="${options.min}"` : "";
  const step = options.step ? `step="${options.step}"` : "";
  const max = options.max != null ? `max="${options.max}"` : "";
  let control;
  if (type === "select") {
    const items = options.choices || [];
    control = `<select id="${id}" ${required}><option value="">選択してください</option>${items.map((choice) => `<option value="${escapeHTML(choice)}">${escapeHTML(choice)}</option>`).join("")}</select>`;
  } else if (type === "textarea") {
    control = `<textarea id="${id}" ${required} ${placeholder}></textarea>`;
  } else if (options.unit) {
    control = `<div class="input-with-unit"><input id="${id}" type="${type}" ${required} ${placeholder} ${min} ${max} ${step}><span class="unit">${options.unit}</span></div>`;
  } else {
    control = `<input id="${id}" type="${type}" ${required} ${placeholder} ${min} ${max} ${step}>`;
  }
  return `<div class="field ${options.full ? "full" : ""}"><label for="${id}">${label}${optional}</label>${control}</div>`;
}

function renderProductInputs() {
  if (!catalog.length) {
    return `<div class="empty-state product-empty"><div><strong>商品マスターが未登録です</strong><p>商品・価格一覧から、商品名と価格を手入力してください。</p><button type="button" class="button button-secondary button-compact" data-view="catalog">商品を登録する</button></div></div>`;
  }
  return GROUP_ORDER.map((group) => {
    const products = catalog.filter((product) => product.group === group);
    if (!products.length) return "";
    return `<section class="product-group"><h3 class="product-group-title"><span>${group}</span><span class="product-count">${products.length}商品</span></h3><div class="product-grid">${products.map((product) => `<label class="product-row"><span><span class="product-name">${escapeHTML(product.name)}</span><span class="product-price">${yen(product.price)} / 個</span></span><input type="number" min="0" step="1" inputmode="numeric" value="0" data-quantity="${product.id}" aria-label="${escapeHTML(product.name)}の販売数"></label>`).join("")}</div></section>`;
  }).join("");
}

function renderEntry() {
  return `${pageHeading("日報入力", "営業日の記録を入力します。日付ごとに1件保存できます。", `<button class="button button-secondary button-compact" id="new-report">新しい日報</button>`)}
    <form id="report-form" class="form-layout">
      <div class="form-stack">
        <section class="form-card"><div class="section-title"><div><h2>売上・営業情報</h2><p>売上額と客数はレジ集計を入力してください。</p></div></div><div class="field-grid">
          ${fieldMarkup("report-date", "営業日", "date", { required: true })}
          ${fieldMarkup("report-sales", "売上", "number", { required: true, min: 0, step: 1, unit: "円", placeholder: "0" })}
          ${fieldMarkup("report-customers", "客数", "number", { required: true, min: 0, step: 1, unit: "人", placeholder: "0" })}
          ${fieldMarkup("report-weather", "天気", "select", { choices: WEATHER_OPTIONS })}
          ${fieldMarkup("report-temperature", "最高気温", "number", { optional: true, min: -20, max: 50, step: 0.1, unit: "℃", placeholder: "例：22" })}
          ${fieldMarkup("report-crowding", "混雑", "select", { choices: CROWD_OPTIONS })}
        </div></section>
        <section class="form-card"><div class="section-title"><div><h2>商品別販売数</h2><p>商品マスターの現在価格を参考表示しています。売上合計とは別に記録します。</p></div></div><div id="product-inputs">${renderProductInputs()}</div><div class="entry-totals"><div class="entry-total"><span>アイス合計</span><strong id="ice-total">0点</strong></div><div class="entry-total"><span>箱入り合計</span><strong id="box-total">0点</strong></div></div></section>
        <section class="form-card"><div class="section-title"><div><h2>品切れ・廃棄・特記事項</h2><p>必要な項目だけ記入できます。</p></div></div><div class="field-grid">
          ${fieldMarkup("report-soldout", "品切れ商品", "textarea", { optional: true, full: true, placeholder: "例：商品名・時間帯" })}
          ${fieldMarkup("report-waste", "廃棄", "textarea", { optional: true, full: true, placeholder: "例：商品名・数量・理由など" })}
          ${fieldMarkup("report-notes", "特記事項", "textarea", { optional: true, full: true, placeholder: "申し送りや当日の気づき" })}
        </div></section>
      </div>
      <aside class="entry-sidebar">
        <div class="ticket-card"><div class="ticket-label">本日の客単価</div><div class="ticket-value" id="ticket-preview">¥0</div><div class="ticket-help">売上 ÷ 客数で自動計算</div></div>
        <div class="form-actions"><button class="button button-primary" type="submit" id="save-report">日報を保存</button><button class="button button-secondary" type="button" id="clear-form">入力をクリア</button></div>
        <div class="hint-box"><strong>保存について</strong><br>日報はパスワードで暗号化し、このブラウザ内に保存されます。PCとスマホの間で自動同期はされません。端末を移すときは「商品・価格一覧」から暗号化JSONバックアップを使えます。</div>
      </aside>
    </form>`;
}

function renderCatalog() {
  const groups = GROUP_ORDER.map((group) => {
    const products = catalog.filter((product) => product.group === group);
    if (!products.length) return "";
    return `<article class="catalog-card"><h2>${group}<span class="product-count"> · ${products.length}商品</span></h2><ul class="catalog-list">${products.map((product) => `<li><span><span class="catalog-product-name">${escapeHTML(product.name)}</span><strong>${yen(product.price)}</strong></span><span class="catalog-actions"><button class="text-button" type="button" data-edit-product="${product.id}">編集</button><button class="text-button text-danger" type="button" data-delete-product="${product.id}">削除</button></span></li>`).join("")}</ul></article>`;
  }).join("");
  const productList = groups || `<div class="empty-state"><div><strong>商品はまだ登録されていません</strong><p>商品名・価格はこの画面で手入力できます。コードには書き込まれません。</p></div></div>`;
  return `${pageHeading("商品・価格一覧", "商品名・価格を手入力して、このブラウザ内に保存します。日報には入力時点の価格を記録します。")}
    <section class="form-card catalog-form-card"><div class="section-title"><div><h2>商品を追加</h2><p>登録内容は公開ソースに含めず、パスワードで暗号化してブラウザに保存します。</p></div></div><form id="product-form"><div class="field-grid">
      ${fieldMarkup("new-product-name", "商品名", "text", { required: true, placeholder: "商品名を入力" })}
      ${fieldMarkup("new-product-price", "販売価格", "number", { required: true, min: 0, step: 1, unit: "円", placeholder: "0" })}
      ${fieldMarkup("new-product-group", "分類", "select", { required: true, choices: GROUP_ORDER })}
    </div><div class="product-form-actions"><button class="button button-primary button-compact" type="submit">＋ 商品を登録</button></div></form></section>
    <section class="catalog-grid">${productList}</section>
    <section class="data-tools">
      <article class="tool-card"><h2>商品マスターと日報をバックアップ</h2><p>暗号化したJSONファイルを保存します。別の端末で読み込むときは、この保管庫のパスワードが必要です。</p><button class="button button-secondary" id="export-json">暗号化JSONを保存</button></article>
      <article class="tool-card"><h2>暗号化バックアップを読み込む</h2><p>同じパスワードで作成したバックアップを取り込みます。同じ商品ID・営業日の記録は更新されます。</p><input class="file-input" id="import-file" type="file" accept="application/json,.json"><button class="button button-secondary" id="import-json">JSONを選択</button></article>
    </section>
    <aside class="privacy-banner"><span class="shield" aria-hidden="true">▣</span><span><strong>データの保存先について</strong><br>商品マスターと日報はAES-GCMで暗号化してこのブラウザに保存し、パスワードは保存・送信しません。アプリを開いている間はデータが画面上で読める状態になるため、信頼できる端末で使い、離席時はロックしてください。CSVはクリックすると平文でダウンロードされます。バックアップとCSVは会社承認済みの保管先を使ってください。</span></aside>`;
}

function render() {
  const views = {
    dashboard: renderDashboard,
    entry: renderEntry,
    monthly: renderMonthly,
    catalog: renderCatalog
  };
  $("#main-content").innerHTML = views[activeView]();
  if (activeView === "entry") initializeEntryForm();
  if (activeView === "monthly") {
    $("#export-csv")?.addEventListener("click", exportCSV);
    $$('[data-product-chart-mode]').forEach((button) => button.addEventListener("click", () => {
      const metric = button.dataset.productChartMode;
      $$('[data-product-chart-mode]').forEach((control) => {
        const isActive = control === button;
        control.classList.toggle("is-active", isActive);
        control.setAttribute("aria-pressed", String(isActive));
      });
      $("#menu-product-chart").innerHTML = menuProductChart(productBreakdown(monthReports(activeMonth())), metric);
    }));
  }
  if (activeView === "catalog") initializeDataTools();
  $$("[data-view]", $("#main-content")).forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $$("[data-edit-date]", $("#main-content")).forEach((button) => button.addEventListener("click", () => editReport(button.dataset.editDate)));
}

function initializeEntryForm() {
  const dateInput = $("#report-date");
  dateInput.value = localDateISO();
  dateInput.addEventListener("change", () => loadReportIntoForm(dateInput.value));
  $("#report-sales").addEventListener("input", updateTicketPreview);
  $("#report-customers").addEventListener("input", updateTicketPreview);
  $$("[data-quantity]").forEach((input) => input.addEventListener("input", updateCategoryTotals));
  $("#report-form").addEventListener("submit", saveReportFromForm);
  $("#new-report").addEventListener("click", () => {
    $("#report-form").reset();
    dateInput.value = localDateISO();
    clearQuantities();
    setSaveButtonLabel();
    updateTicketPreview();
    updateCategoryTotals();
  });
  $("#clear-form").addEventListener("click", () => {
    const date = dateInput.value || localDateISO();
    $("#report-form").reset();
    dateInput.value = date;
    clearQuantities();
    setSaveButtonLabel();
    updateTicketPreview();
    updateCategoryTotals();
  });
  loadReportIntoForm(dateInput.value);
}

function clearQuantities() { $$("[data-quantity]").forEach((input) => { input.value = "0"; }); }

function loadReportIntoForm(date) {
  const report = reports.find((item) => item.date === date);
  const form = $("#report-form");
  form.reset();
  $("#report-date").value = date;
  clearQuantities();
  if (report) {
    $("#report-sales").value = report.sales ?? "";
    $("#report-customers").value = report.customers ?? "";
    $("#report-weather").value = report.weather || "";
    $("#report-temperature").value = report.temperature ?? "";
    $("#report-crowding").value = report.crowding || "";
    $("#report-soldout").value = report.soldOut || "";
    $("#report-waste").value = report.waste || "";
    $("#report-notes").value = report.notes || "";
    Object.entries(report.items || {}).forEach(([id, item]) => {
      const input = $(`[data-quantity="${CSS.escape(id)}"]`);
      if (input) input.value = item.quantity || 0;
    });
  }
  setSaveButtonLabel(Boolean(report));
  updateTicketPreview();
  updateCategoryTotals();
}

function setSaveButtonLabel(isEditing = reports.some((item) => item.date === $("#report-date")?.value)) {
  $("#save-report").textContent = isEditing ? "日報を更新" : "日報を保存";
}

function updateTicketPreview() {
  const sales = Number($("#report-sales").value) || 0;
  const customers = Number($("#report-customers").value) || 0;
  $("#ticket-preview").textContent = yen(customers ? sales / customers : 0);
}

function quantitiesFromForm() {
  const quantities = {};
  $$("[data-quantity]").forEach((input) => {
    const quantity = Math.max(0, Math.floor(Number(input.value) || 0));
    if (quantity > 0) {
      const product = catalog.find((item) => item.id === input.dataset.quantity);
      if (!product) return;
      quantities[product.id] = { quantity, name: product.name, price: product.price, kind: product.kind };
    }
  });
  return quantities;
}

function updateCategoryTotals() {
  const quantities = quantitiesFromForm();
  const items = Object.values(quantities);
  const ice = items.reduce((sum, item) => sum + (item.kind === "ice" ? item.quantity : 0), 0);
  const boxes = items.reduce((sum, item) => sum + (item.kind === "box" ? item.quantity : 0), 0);
  $("#ice-total").textContent = `${numberText(ice)}点`;
  $("#box-total").textContent = `${numberText(boxes)}点`;
}

async function saveReportFromForm(event) {
  event.preventDefault();
  const date = $("#report-date").value;
  if (!date) { showToast("営業日を入力してください。"); return; }
  const oldReport = reports.find((item) => item.date === date);
  const report = {
    date,
    sales: Math.max(0, Math.round(Number($("#report-sales").value) || 0)),
    customers: Math.max(0, Math.floor(Number($("#report-customers").value) || 0)),
    weather: $("#report-weather").value,
    temperature: $("#report-temperature").value === "" ? "" : Number($("#report-temperature").value),
    crowding: $("#report-crowding").value,
    soldOut: $("#report-soldout").value.trim(),
    waste: $("#report-waste").value.trim(),
    notes: $("#report-notes").value.trim(),
    items: quantitiesFromForm(),
    createdAt: oldReport?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  reports = reports.filter((item) => item.date !== date).concat(report).sort((a, b) => a.date.localeCompare(b.date));
  if (!await persistVault()) return;
  showToast(`${formatDate(date, { year: "numeric", month: "long", day: "numeric" })}の日報を保存しました。`);
  setView("dashboard");
}

function editReport(date) {
  $("#active-month").value = date.slice(0, 7);
  setView("entry");
  $("#report-date").value = date;
  loadReportIntoForm(date);
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCSV() {
  const month = activeMonth();
  const list = monthReports(month);
  if (!list.length) { showToast("書き出す日報がありません。"); return; }
  const products = productsUsedIn(list);
  const headers = ["営業日", "売上", "客数", "客単価", "天気", "最高気温", "混雑", "アイス合計", "箱入り合計", "品切れ商品", "廃棄", "特記事項", ...products.map((product) => product.name)];
  const lines = [headers, ...list.map((report) => {
    const ticket = report.customers ? Math.round(report.sales / report.customers) : 0;
    const row = [report.date, report.sales, report.customers, ticket, report.weather, report.temperature, report.crowding, itemQuantityByKind(report, "ice"), itemQuantityByKind(report, "box"), report.soldOut, report.waste, report.notes];
    products.forEach((product) => row.push(report.items?.[product.id]?.quantity || 0));
    return row;
  })].map((row) => row.map(csvEscape).join(",")).join("\r\n");
  downloadBlob(`絶叫焼き_日報_${month}.csv`, `\uFEFF${lines}`, "text/csv;charset=utf-8");
  showToast(`${month}の日報CSVを保存しました。`);
}

function productsUsedIn(list) {
  const products = new Map(catalog.map((product) => [product.id, product]));
  list.forEach((report) => Object.entries(report.items || {}).forEach(([id, item]) => {
    if (!products.has(id)) {
      products.set(id, {
        id,
        name: item.name || id,
        group: item.kind === "ice" ? "アイス" : item.kind === "box" ? "箱入り" : "たい焼き・単品"
      });
    }
  }));
  return [...products.values()];
}

function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initializeDataTools() {
  $("#product-form").addEventListener("submit", addProductFromForm);
  $$("[data-edit-product]").forEach((button) => button.addEventListener("click", () => editProduct(button.dataset.editProduct)));
  $$("[data-delete-product]").forEach((button) => button.addEventListener("click", () => deleteProduct(button.dataset.deleteProduct)));
  $("#export-json").addEventListener("click", async () => {
    if (!await persistVault()) return;
    const encrypted = JSON.parse(localStorage.getItem(VAULT_KEY));
    const payload = { app: "zekkyo-sales-manager", version: 1, encrypted };
    downloadBlob(`絶叫焼き_暗号化バックアップ_${localDateISO()}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
    showToast("暗号化バックアップを保存しました。");
  });
  $("#import-json").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", importJSON);
}

function newProductId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function addProductFromForm(event) {
  event.preventDefault();
  const name = $("#new-product-name").value.trim();
  const price = Number($("#new-product-price").value);
  const group = $("#new-product-group").value;
  if (!name || !Number.isFinite(price) || price < 0 || !GROUP_ORDER.includes(group)) {
    showToast("商品名・価格・分類を確認してください。");
    return;
  }
  if (catalog.some((product) => product.name === name && product.group === group)) {
    showToast("同じ分類に同じ商品名が登録されています。");
    return;
  }
  catalog.push({ id: newProductId(), name, price: Math.round(price), group, kind: productKind(group) });
  if (!await persistVault()) return;
  render();
  showToast("商品を登録し、暗号化して保存しました。");
}

async function editProduct(id) {
  const product = catalog.find((item) => item.id === id);
  if (!product) return;
  const name = window.prompt("商品名", product.name);
  if (name === null || !name.trim()) return;
  const priceText = window.prompt("販売価格（円）", String(product.price));
  if (priceText === null || priceText.trim() === "") return;
  const price = Number(priceText);
  if (!Number.isFinite(price) || price < 0) { showToast("価格は0以上の数字で入力してください。"); return; }
  product.name = name.trim();
  product.price = Math.round(price);
  if (!await persistVault()) return;
  render();
  showToast("商品マスターを更新しました。");
}

async function deleteProduct(id) {
  const product = catalog.find((item) => item.id === id);
  if (!product || !window.confirm(`「${product.name}」を商品マスターから削除しますか？保存済み日報の記録は残ります。`)) return;
  catalog = catalog.filter((item) => item.id !== id);
  if (!await persistVault()) return;
  render();
  showToast("商品を商品マスターから削除しました。");
}

async function importJSON(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (payload?.app !== "zekkyo-sales-manager" || !payload.encrypted) throw new Error("format");
    const password = window.prompt("このバックアップを作成したときのパスワードを入力してください。");
    if (password === null) return;
    const decoded = await decryptVaultRecord(payload.encrypted, password);
    const ok = window.confirm(`${decoded.catalog.length}件の商品と${decoded.reports.length}件の日報を読み込みます。同じ商品ID・営業日の記録はバックアップの内容で置き換わります。続けますか？`);
    if (!ok) return;
    const mergedProducts = new Map(catalog.map((product) => [product.id, product]));
    decoded.catalog.forEach((product) => mergedProducts.set(product.id, product));
    catalog = [...mergedProducts.values()];
    const merged = new Map(reports.map((report) => [report.date, report]));
    decoded.reports.forEach((report) => merged.set(report.date, report));
    reports = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (!await persistVault()) return;
    render();
    showToast(`${decoded.reports.length}件の日報と商品マスターを読み込みました。`);
  } catch {
    showToast("バックアップを解除できませんでした。パスワードとファイルを確認してください。");
  } finally {
    event.target.value = "";
  }
}

function setVaultMode(isUnlock) {
  $("#vault-confirm-group").hidden = isUnlock;
  $("#vault-password-confirm").required = !isUnlock;
  $("#vault-password").autocomplete = isUnlock ? "current-password" : "new-password";
  $("#vault-heading").textContent = isUnlock ? "日報データを解除" : "日報データを暗号化して保存";
  $("#vault-description").textContent = isUnlock
    ? "設定済みのパスワードを入力してください。商品マスターと日報は暗号化して保存されています。"
    : "最初に12文字以上のパスワードを設定します。商品マスターと日報は暗号化してこのブラウザに保存します。";
  $("#vault-password-label").textContent = isUnlock ? "パスワード" : "新しいパスワード";
  $("#vault-submit").textContent = isUnlock ? "解除" : "パスワードを設定";
  $("#vault-status").textContent = "";
  $("#vault-password").value = "";
  $("#vault-password-confirm").value = "";
}

function openVault(data, key, salt, iterations = VAULT_ITERATIONS) {
  reports = data.reports;
  catalog = data.catalog;
  vaultKey = key;
  vaultSalt = salt;
  vaultIterations = iterations;
  $("#vault-form").reset();
  $("#vault-status").textContent = "";
  $("#vault-gate").hidden = true;
  $("#app-shell").hidden = false;
  $("#active-month").value = currentMonth();
  render();
}

async function submitVaultForm(event) {
  event.preventDefault();
  const password = $("#vault-password").value;
  $("#vault-status").textContent = "暗号化処理中…";
  $("#vault-submit").disabled = true;
  try {
    const existingRecord = localStorage.getItem(VAULT_KEY);
    if (existingRecord) {
      const record = JSON.parse(existingRecord);
      const decoded = await decryptVaultRecord(record, password);
      openVault(decoded, decoded.key, decoded.salt, decoded.iterations);
      return;
    }
    if (password.length < 12) throw new Error("password-too-short");
    if (password !== $("#vault-password-confirm").value) throw new Error("password-mismatch");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveVaultKey(password, salt);
    const data = { reports: loadReports(), catalog: loadCatalog() };
    reports = data.reports;
    catalog = data.catalog;
    vaultKey = key;
    vaultSalt = salt;
    if (!await persistVault()) throw new Error("save-failed");
    localStorage.removeItem(LEGACY_REPORTS_KEY);
    localStorage.removeItem(LEGACY_CATALOG_KEY);
    openVault(data, key, salt);
  } catch (error) {
    const message = error?.message === "secure-context-required"
      ? "暗号化機能を使うにはHTTPSで開いてください。ファイルを直接開かず、GitHub PagesなどのHTTPS環境で利用してください。"
      : error?.name === "SecurityError"
        ? "このブラウザではローカル保存が許可されていません。ブラウザの保存設定を確認してください。"
        : error?.message === "password-mismatch"
          ? "確認用パスワードが一致しません。"
          : error?.message === "password-too-short"
            ? "パスワードは12文字以上にしてください。"
            : "解除できませんでした。パスワードを確認してください。";
    $("#vault-status").textContent = message;
  } finally {
    $("#vault-submit").disabled = false;
  }
}

function lockVault() {
  vaultKey = null;
  vaultSalt = null;
  vaultIterations = VAULT_ITERATIONS;
  reports = [];
  catalog = [];
  $("#main-content").replaceChildren();
  $("#toast").textContent = "";
  $("#toast").classList.remove("is-visible");
  $("#app-shell").hidden = true;
  $("#vault-gate").hidden = false;
  setVaultMode(true);
}

function initialize() {
  let hasVault = false;
  let storageAvailable = true;
  try { hasVault = Boolean(localStorage.getItem(VAULT_KEY)); } catch { storageAvailable = false; }
  setVaultMode(hasVault);
  if (!globalThis.crypto?.subtle) {
    $("#vault-status").textContent = "このブラウザでは暗号化機能を使えません。HTTPS環境の最新ブラウザで開いてください。";
    $("#vault-submit").disabled = true;
  } else if (!storageAvailable) {
    $("#vault-status").textContent = "このブラウザではローカル保存が許可されていません。ブラウザの保存設定を確認してください。";
    $("#vault-submit").disabled = true;
  }
  $("#vault-form").addEventListener("submit", submitVaultForm);
  $("#active-month").addEventListener("change", render);
  $$("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $("#lock-app").addEventListener("click", lockVault);
}

initialize();
