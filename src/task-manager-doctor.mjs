const serviceRemedy = "task-manager service install";

function row(label, ok, detail, remedy = serviceRemedy) {
  return { label, status: ok ? "ok" : "fail", detail, remedy };
}

export function taskManagerDoctorRows({
  platform,
  standalone,
  service,
  health,
  privateState,
  routerMode,
} = {}) {
  if (platform !== "win32" || standalone !== true) return [];

  const serviceOk = service?.installed === true
    && service.loaded === true
    && service.state === "running"
    && service.canonical === true
    && service.healthy === true
    && Number.isSafeInteger(service.pid)
    && service.pid > 0;
  const healthOk = health?.ok === true
    && health.service === "codex-router-task-manager"
    && health.mode === "standalone"
    && Number.isSafeInteger(health.pid)
    && health.pid === service?.pid;
  const privacyOk = privateState?.caller === true
    && privateState.marker === true
    && privateState.process === true;
  const topologyOk = routerMode === "standalone";

  return [
    row("Task Manager service", serviceOk,
      serviceOk ? "recognized login task is running" : "login task is missing, unknown, non-canonical, or unhealthy"),
    row("Task Manager health", healthOk,
      healthOk ? "standalone manager identity matches its recognized process" : "standalone manager identity is unavailable or does not match its process"),
    row("Task Manager privacy", privacyOk,
      privacyOk ? "caller, marker, and process state are private" : "caller, marker, or process state is missing or not private",
      "doctor --fix"),
    row("Task Manager topology", topologyOk,
      topologyOk ? "Router reports standalone Task Manager mode" : "Router does not report standalone Task Manager mode"),
  ];
}
