import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("task manager UI exposes guarded Router lifecycle controls", () => {
  const html = readFileSync(path.join(root, "src", "task-manager-ui.html"), "utf8");

  for (const id of [
    "router-start-btn",
    "router-stop-btn",
    "router-restart-btn",
    "router-service-state",
    "router-operation-result",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }

  assert.match(html, /id=["']router-service-card["'][^>]*hidden/);
  assert.match(html, /api\(["']api\/router\/status["']\)/);
  assert.match(html, /api\(`api\/router\/\$\{action\}`/);
  assert.match(html, /confirm\([^)]*停止[^)]*活跃[^)]*Codex[^)]*断开/);
  assert.match(html, /confirm\([^)]*重启/);
  assert.match(html, /重启 Router 服务可能会中断活跃 Codex 请求/);
  assert.match(html, /routerOperationPending/);
  assert.match(html, /\[['"]starting['"], ['"]stopping['"], ['"]restarting['"]\]/);
});

test("overview keeps Router service first and combines account with failover", () => {
  const html = readFileSync(path.join(root, "src", "task-manager-ui.html"), "utf8");
  const start = html.indexOf('<section class="stats">');
  const stats = html.slice(start, html.indexOf("</section>", start));

  assert.equal((stats.match(/class=["']card stat["']/g) || []).length, 4);
  const router = stats.indexOf("Router 服务");
  const proxy = stats.indexOf("代理状态");
  const account = stats.indexOf("当前使用账号");
  const quota = stats.indexOf("订阅 / 剩余额度");
  assert.ok(router < proxy && proxy < account && account < quota);
  assert.match(stats.slice(account, quota), /id=["']active-account["'][\s\S]*id=["']failover-badge["'][\s\S]*id=["']failover-last["']/);
});

test("initial load reuses status, loads independent data in parallel, and delays polling", () => {
  const html = readFileSync(path.join(root, "src", "task-manager-ui.html"), "utf8");
  assert.match(html, /async function loadStatus\(status\)[\s\S]*status \|\|= await api\(["']api\/status["']\)/);
  assert.match(html, /await loadStatus\(status\)/);
  assert.match(html, /await Promise\.all\(\[[\s\S]*loadAccounts\(\)[\s\S]*loadRouterService\(\)/);
  assert.match(html, /function schedulePolls\(\)[\s\S]*setTimeout\(pollLog, logIntervalMs\)[\s\S]*setTimeout\(pollAccounts, accountsIntervalMs\)/);
  const boot = html.match(/async function boot\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(boot, /schedulePolls\(\)/);
  assert.doesNotMatch(boot, /\bpollLog\(\);[\s\S]*\bpollAccounts\(\);/);
});
