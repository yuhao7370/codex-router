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
