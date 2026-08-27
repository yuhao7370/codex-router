(function (global) {
  "use strict";

  function fmtTokens(value) {
    const n = Math.round(Number(value) || 0);
    if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
    if (n >= 1e4) return (n / 1e4).toFixed(2) + " 万";
    return n.toLocaleString("en-US");
  }

  function fmtUsd(value) {
    const n = Number(value) || 0;
    return "$" + n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }

  function shortId(id) {
    const value = String(id || "");
    return value.length > 12 ? value.slice(0, 8) + "…" : value;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function endpoint(path) {
    return new URL(String(path).replace(/^\/+/, ""), document.baseURI);
  }

  async function api(path, options) {
    const request = { ...(options || {}) };
    if (request.method === "POST") {
      request.headers = { "Content-Type": "application/json", ...(request.headers || {}) };
      if (request.body === undefined) request.body = "{}";
    }
    const response = await fetch(endpoint(path), request);
    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      body = null;
    }
    if (!response.ok) {
      throw new Error(body && body.error ? body.error : "HTTP " + response.status);
    }
    return body;
  }

  const RANGE_NAMES = {
    today: "今日",
    yesterday: "昨日",
    "7d": "7 天",
    "30d": "30 天",
    "90d": "90 天",
  };
  const RANGE_STORAGE_KEY = "usage-range";
  const validRange = (value) => Object.hasOwn(RANGE_NAMES, value);

  const STYLES = `
.usage-app { font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #161d2b; }
.usage-app, .usage-app *, .usage-app *::before, .usage-app *::after { box-sizing: border-box; }
.usage-app .up-card { background: #fff; border: 1px solid #e3e8f0; border-radius: 14px; padding: 18px 20px; box-shadow: 0 1px 2px rgba(16,24,40,0.04); }
.usage-app .up-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.usage-app .up-card-head h2 { font-size: 16px; font-weight: 700; margin: 0; }
.usage-app .up-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.usage-app .up-foot { font-size: 12px; color: #68738a; }
.usage-app .up-mono { font-family: ui-monospace, Consolas, monospace; }
.usage-app .up-btn { border: 1px solid #e3e8f0; background: #fff; color: #68738a; padding: 6px 12px; border-radius: 8px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.usage-app .up-btn:hover { background: #f4f6fa; }
.usage-app .up-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #68738a; cursor: pointer; user-select: none; }
.usage-app .up-toggle input { margin: 0; cursor: pointer; }
.usage-app .up-range { display: inline-flex; border: 1px solid #e3e8f0; border-radius: 8px; overflow: hidden; background: #fff; margin: 2px 0 16px; }
.usage-app .up-seg { border: none; background: transparent; padding: 6px 12px; font: inherit; font-size: 12px; font-weight: 600; color: #68738a; cursor: pointer; }
.usage-app .up-seg + .up-seg { border-left: 1px solid #e3e8f0; }
.usage-app .up-seg.active { background: #4f46e5; color: #fff; }
.usage-app .up-hero { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 18px; }
.usage-app .up-number { display: flex; flex-direction: column; }
.usage-app .up-label { font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #68738a; }
.usage-app .up-value { margin-top: 8px; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
.usage-app .up-value.up-accent { color: #4f46e5; }
.usage-app .up-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.45fr); gap: 18px; align-items: start; }
.usage-app .up-grid.detail-hidden { grid-template-columns: 1fr; }
.usage-app .up-grid h3 { margin: 0 0 10px; font-size: 13px; font-weight: 700; color: #2b3550; display: flex; align-items: center; gap: 8px; }
.usage-app .up-grid h3::before { content: ""; width: 3px; height: 12px; border-radius: 2px; background: linear-gradient(180deg, #4f46e5, #7c3aed); }
.usage-app .up-table-wrap { overflow-x: auto; margin: 0 -4px; padding: 0 4px; }
.usage-app table { width: 100%; border-collapse: collapse; }
.usage-app th, .usage-app td { text-align: left; padding: 8px 10px; font-size: 12.5px; border-bottom: 1px solid #eef1f6; white-space: nowrap; }
.usage-app th { color: #68738a; font-weight: 600; }
.usage-app .up-muted { color: #68738a; }
.usage-app .up-result { font-size: 12px; margin: 6px 0; }
.usage-app .up-result.ok { color: #0a9d6c; }
.usage-app .up-result.err { color: #d9385e; }
@media (max-width: 760px) {
  .usage-app .up-hero { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .usage-app .up-grid { grid-template-columns: 1fr; }
}
@media (max-width: 480px) {
  .usage-app .up-hero { grid-template-columns: 1fr; }
}
`;

  let styleInjected = false;
  function injectStyles() {
    if (styleInjected) return;
    styleInjected = true;
    const style = document.createElement("style");
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  function markup() {
    return (
      '<div class="up-card">' +
      '  <div class="up-card-head">' +
      "    <h2>用量统计</h2>" +
      '    <div class="up-actions">' +
      '      <label class="up-toggle"><input type="checkbox" data-role="detail-toggle" checked> 显示明细</label>' +
      '      <button type="button" class="up-btn" data-role="sync">同步在线价格</button>' +
      '      <button type="button" class="up-btn" data-role="refresh">刷新</button>' +
      "    </div>" +
      "  </div>" +
      '  <div class="up-result" data-role="sync-result" hidden></div>' +
      '  <div class="up-range" role="group" aria-label="时间范围">' +
      '    <button type="button" class="up-seg" data-range="today">今日</button>' +
      '    <button type="button" class="up-seg" data-range="yesterday">昨日</button>' +
      '    <button type="button" class="up-seg" data-range="7d">7 天</button>' +
      '    <button type="button" class="up-seg" data-range="30d">30 天</button>' +
      '    <button type="button" class="up-seg active" data-range="90d">90 天</button>' +
      "  </div>" +
      '  <div class="up-hero">' +
      '    <div class="up-number"><div class="up-label">请求数</div><div class="up-value" data-role="requests">—</div></div>' +
      '    <div class="up-number"><div class="up-label" data-role="tokens-label">总 Token（90 天）</div><div class="up-value" data-role="tokens">—</div></div>' +
      '    <div class="up-number"><div class="up-label">缓存命中 Token</div><div class="up-value" data-role="cache">—</div></div>' +
      '    <div class="up-number"><div class="up-label" data-role="cost-label">等效成本（90 天）</div><div class="up-value up-accent" data-role="cost">—</div></div>' +
      "  </div>" +
      '  <div class="up-grid">' +
      "    <div>" +
      "      <h3>账号用量</h3>" +
      '      <div class="up-table-wrap"><table><thead><tr><th>账号</th><th>输入</th><th>输出</th><th>缓存</th><th>总 Token</th><th>等效成本</th></tr></thead><tbody data-role="account-body"></tbody></table></div>' +
      "    </div>" +
      '    <div data-role="detail">' +
      "      <h3>模型明细</h3>" +
      '      <div class="up-table-wrap"><table><thead><tr><th>账号</th><th>模型</th><th>总 Token</th><th>等效成本</th></tr></thead><tbody data-role="model-body"></tbody></table></div>' +
      "    </div>" +
      "  </div>" +
      "</div>"
    );
  }

  function init(root, options) {
    options = options || {};
    const getPollInterval =
      typeof options.getPollInterval === "function"
        ? options.getPollInterval
        : function () {
            return options.pollIntervalMs || 5000;
          };
    const defaultRange = validRange(options.defaultRange) ? options.defaultRange : "90d";
    let range = defaultRange;
    try {
      const savedRange = localStorage.getItem(RANGE_STORAGE_KEY);
      if (validRange(savedRange)) range = savedRange;
    } catch (error) {}

    injectStyles();
    root.classList.add("usage-app");
    root.innerHTML = markup();

    function q(selector) {
      return root.querySelector(selector);
    }

    function setResult(ok, text) {
      const node = q('[data-role="sync-result"]');
      node.hidden = false;
      node.className = "up-result " + (ok ? "ok" : "err");
      node.textContent = text;
    }

    function render(data) {
      const accounts = Array.isArray(data.accounts) ? data.accounts : [];

      let requests = 0;
      let tokens = 0;
      let cache = 0;
      let cost = 0;
      for (const account of accounts) {
        requests += Number(account.requests) || 0;
        tokens += Number(account.totalTokens) || 0;
        cache += Number(account.cachedInputTokens) || 0;
        cost += Number(account.totalCost) || 0;
      }
      q('[data-role="requests"]').textContent = fmtTokens(requests);
      q('[data-role="tokens"]').textContent = fmtTokens(tokens);
      q('[data-role="cache"]').textContent = fmtTokens(cache);
      q('[data-role="cost"]').textContent = fmtUsd(cost);

      const accountRows = accounts
        .filter(function (account) {
          return (account.requests || 0) > 0 || (account.totalTokens || 0) > 0;
        })
        .sort(function (left, right) {
          return (
            (right.totalTokens || 0) - (left.totalTokens || 0) ||
            (right.requests || 0) - (left.requests || 0)
          );
        });
      const accountBody = q('[data-role="account-body"]');
      accountBody.textContent = "";
      for (const account of accountRows) {
        const label = account.email || shortId(account.accountId) || "—";
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + escapeHtml(label) + "</td>" +
          '<td class="up-mono">' + fmtTokens(account.inputTokens) + "</td>" +
          '<td class="up-mono">' + fmtTokens(account.outputTokens) + "</td>" +
          '<td class="up-mono">' + fmtTokens(account.cachedInputTokens) + "</td>" +
          '<td class="up-mono">' + fmtTokens(account.totalTokens) + "</td>" +
          '<td class="up-mono">' + fmtUsd(account.totalCost) + "</td>";
        accountBody.appendChild(tr);
      }
      if (accountRows.length === 0) {
        accountBody.innerHTML = '<tr><td colspan="6" class="up-muted">暂无用量记录</td></tr>';
      }

      const modelRows = [];
      for (const account of accounts) {
        for (const model of Array.isArray(account.models) ? account.models : []) {
          if ((model.requests || 0) > 0 || (model.totalTokens || 0) > 0) {
            modelRows.push({
              accountLabel: account.email || shortId(account.accountId) || "—",
              model: model,
            });
          }
        }
      }
      modelRows.sort(function (left, right) {
        return (
          (right.model.totalTokens || 0) - (left.model.totalTokens || 0) ||
          (right.model.requests || 0) - (left.model.requests || 0)
        );
      });
      const modelBody = q('[data-role="model-body"]');
      modelBody.textContent = "";
      for (const row of modelRows.slice(0, 300)) {
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + escapeHtml(row.accountLabel) + "</td>" +
          '<td class="up-mono">' + escapeHtml(row.model.displayName || row.model.slug) + "</td>" +
          '<td class="up-mono">' + fmtTokens(row.model.totalTokens) + "</td>" +
          '<td class="up-mono">' + (row.model.priced ? fmtUsd(row.model.totalCost) : "—") + "</td>";
        modelBody.appendChild(tr);
      }
      if (modelRows.length === 0) {
        modelBody.innerHTML = '<tr><td colspan="4" class="up-muted">暂无用量记录</td></tr>';
      }
    }

    let loading = false;
    let reloadPending = false;
    async function load() {
      if (loading) return;
      loading = true;
      const requestedRange = range;
      try {
        const data = await api("api/usage?range=" + encodeURIComponent(requestedRange));
        if (requestedRange === range) render(data);
      } catch (error) {
        // Keep the last snapshot on transient failures.
      }
      loading = false;
      if (reloadPending) {
        reloadPending = false;
        return load();
      }
    }

    function setRange(next) {
      if (!validRange(next)) return;
      range = next;
      try {
        localStorage.setItem(RANGE_STORAGE_KEY, next);
      } catch (error) {}
      root.querySelectorAll(".up-seg").forEach(function (seg) {
        seg.classList.toggle("active", seg.getAttribute("data-range") === next);
      });
      const label = RANGE_NAMES[next];
      q('[data-role="tokens-label"]').textContent = "总 Token（" + label + "）";
      q('[data-role="cost-label"]').textContent = "等效成本（" + label + "）";
      if (loading) reloadPending = true;
      load();
    }

    root.querySelectorAll(".up-seg").forEach(function (seg) {
      seg.addEventListener("click", function () {
        setRange(seg.getAttribute("data-range"));
      });
    });
    q('[data-role="refresh"]').addEventListener("click", load);
    q('[data-role="sync"]').addEventListener("click", async function () {
      setResult(true, "正在同步…");
      try {
        const result = await api("api/usage/sync", { method: "POST" });
        setResult(
          Boolean(result.ok),
          result.ok
            ? "已同步 " + result.modelCount + " 个模型价格"
            : "同步失败：" + (result.error || "未知错误"),
        );
        await load();
      } catch (error) {
        setResult(false, "同步失败：" + error.message);
      }
    });

    setRange(range);

    const detailToggle = q('[data-role="detail-toggle"]');
    const detailColumn = q('[data-role="detail"]');
    const grid = root.querySelector(".up-grid");

    function applyDetail(show) {
      detailToggle.checked = show;
      detailColumn.style.display = show ? "" : "none";
      grid.classList.toggle("detail-hidden", !show);
    }

    let showDetail = true;
    try {
      showDetail = localStorage.getItem("usage-show-detail") !== "0";
    } catch (error) {
      showDetail = true;
    }
    applyDetail(showDetail);

    detailToggle.addEventListener("change", function () {
      applyDetail(detailToggle.checked);
      try {
        localStorage.setItem("usage-show-detail", detailToggle.checked ? "1" : "0");
      } catch (error) {}
    });

    try {
      window.addEventListener("storage", function (event) {
        if (event.key === "usage-show-detail") {
          applyDetail(event.newValue !== "0");
        }
      });
    } catch (error) {}

    let timer = null;
    function scheduleNext() {
      timer = setTimeout(function () {
        load().finally(scheduleNext);
      }, getPollInterval());
    }
    scheduleNext();

    return {
      reload: load,
      setRange: setRange,
      destroy: function () {
        clearTimeout(timer);
      },
    };
  }

  global.UsagePanel = { init: init };
})(window);
