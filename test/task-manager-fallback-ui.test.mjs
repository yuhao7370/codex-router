import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../src/task-manager-ui.html", import.meta.url), "utf8");
const loadStatusSource = html.match(/  async function loadStatus\(status\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(loadStatusSource, "render the production status function");

async function render(injections, accounts = []) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, {
      textContent: "", style: {},
      set innerHTML(_value) { assert.fail("status log must render text, never HTML"); },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    el, accountIndex: new Map(accounts), formatTime: () => "12:34:56",
    formatAge: () => "now", shortId: (id) => String(id || "—"),
    api: () => assert.fail("provided status must not trigger a network request"),
  });
  vm.runInContext(loadStatusSource, context);
  await context.loadStatus({ enabled: true, port: 6000, injections });
  return elements;
}

test("status renders caller fallback separately with model-access reason and both HTTP outcomes", async () => {
  const elements = await render({ count: 4, fallbackCount: 2, recent: [
    { kind: "native_fallback", fromAccountId: "seat-a", model: "gpt-daybreak-blue-latest", reason: "model_unavailable", status: 200, fastSource: "native" },
    { kind: "native_fallback", fromAccountId: "unknown-seat", model: "<b>Daybreak</b>", reason: "model_unavailable", status: 403 },
    { accountId: "seat-a", fast: true, fastSource: "injected" },
  ] }, [["seat-a", { email: "injected@example.com", plan: "PRO" }]]);
  const log = elements.get("injection-log").textContent;
  assert.match(log, /injected@example\.com → 原生账号 · gpt-daybreak-blue-latest · 模型无权限 · 已回退\(HTTP 200\)/);
  assert.match(log, /unknown-seat → 原生账号 · <b>Daybreak<\/b> · 模型无权限 · 回退请求失败\(HTTP 403\)/);
  assert.match(log, /原生 fast/);
  assert.match(log, /injected@example\.com · PRO · 注入 fast/);
  assert.equal(elements.get("injection-count").textContent, "4");
  assert.equal(elements.get("fallback-count").textContent, "2");
  assert.match(html, /注入 <span class="mono" id="injection-count"/);
  assert.doesNotMatch(html, /成功 <span class="mono" id="injection-count"/);
});

test("old snapshots without fallback counts keep injection-only display working", async () => {
  const elements = await render({ count: 1, recent: [{ accountId: "seat", fastSource: "native" }] });
  assert.equal(elements.get("fallback-count").textContent, "0");
  assert.match(elements.get("injection-log").textContent, /seat · 原生 fast/);
  assert.doesNotMatch(elements.get("injection-log").textContent, /→ 原生账号/);
});
