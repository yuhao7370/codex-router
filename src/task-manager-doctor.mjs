const serviceRemedy = "task-manager service install";

function row(label, ok, detail, remedy = serviceRemedy) {
  return { label, status: ok ? "ok" : "fail", detail, remedy };
}

export function taskManagerDoctorRows({
  platform,
  markerState,
  service,
  health,
  components,
  privateState,
  routerMode,
} = {}) {
  if (platform !== "win32") return [];
  const componentStates = ["task", "wrapper", "launcher", "shortcut", "process"]
    .map((name) => components?.[name]);
  const noComponents = service?.installed === false
    && service?.loaded === false
    && !Number.isSafeInteger(service?.pid)
    && componentStates.every((component) =>
      component?.known === true && component.present === false);
  if (
    noComponents
    && (markerState?.state === "missing" || markerState?.state === "disabled")
  ) return [];

  const enabled = markerState?.known === true
    && markerState.exists === true
    && markerState.enabled === true
    && markerState.state === "enabled";

  const serviceOk = enabled
    && service?.installed === true
    && service.loaded === true
    && service.state === "running"
    && service.canonical === true
    && service.healthy === true
    && service.listener === "owned"
    && Number.isSafeInteger(service.pid)
    && service.pid > 0;
  const healthOk = enabled
    && health?.ok === true
    && health.service === "codex-router-task-manager"
    && health.mode === "standalone"
    && Number.isSafeInteger(health.pid)
    && health.pid === service?.pid;
  const privacyOk = enabled
    && privateState?.caller === true
    && privateState.marker === true
    && privateState.process === true
    && privateState.config === true;
  const topologyOk = enabled
    && routerMode === "standalone"
    && service?.listener === "owned";

  return [
    row("Task Manager service", serviceOk,
      serviceOk ? "recognized login task is running" : "login task is missing, unknown, non-canonical, or unhealthy"),
    row("Task Manager health", healthOk,
      healthOk ? "standalone manager identity matches its recognized process" : "standalone manager identity is unavailable or does not match its process"),
    row("Task Manager privacy", privacyOk,
      privacyOk ? "caller, marker, process, and token configuration are private" : "marker state or private Task Manager files are missing, malformed, disabled, or not private",
      "doctor --fix"),
    row("Task Manager topology", topologyOk,
      topologyOk ? "Router reports standalone Task Manager mode" : "Router does not report standalone Task Manager mode"),
  ];
}
