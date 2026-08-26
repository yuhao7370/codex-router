# Design Specification: Independent Task Manager Service

- **Status**: Accepted
- **Platform scope**: Windows installed service; existing embedded behavior elsewhere
- **Primary UI**: `http://127.0.0.1:4111` behind the existing local caller capability

## Background

The fork's Task Manager UI is currently started by `router.mjs`. It therefore
disappears with the Router process and cannot recover a Router that is stopped,
unhealthy, or unable to start. The UI also reads Router-owned in-memory state
directly, including the active injected account, pool credentials, failover
state, and recent injection events.

The desired outcome is an independent, login-started browser UI that remains
available while the Router is offline and can start, stop, or restart the
existing Router service. Router auto-start remains enabled. The manager starts
silently and never opens a browser at login.

## Goals

1. Keep the Task Manager UI reachable when the Router service is stopped or
   unhealthy.
2. Provide explicit Start, Stop, and Restart controls for the existing Router
   service.
3. Preserve all current account, pool, failover, Fast, usage, pricing, and
   local-router model functions.
4. Keep Router-owned runtime telemetry accurate after the UI moves to another
   process.
5. Install, repair, update, and uninstall the manager transactionally on
   Windows without stranding the Router.
6. Preserve the current embedded UI on non-Windows hosts and in development
   checkouts that have not enabled standalone mode.

## Non-goals

- Replacing or extending the Electron Control Center
- Making the Task Manager process supervise Router children directly
- Changing Router provider selection, routing, retry, Fast, or failover policy
- Adding remote-network access to the manager
- Automatically opening a browser at login
- Implementing independent manager services for macOS or Linux in this change

## Process topology

Windows has two current-user Task Scheduler tasks:

1. **Codex Router Task Manager** starts a hidden Node host at login. It serves
   the browser UI on loopback, exposes bounded service-control actions, and is
   restarted by Task Scheduler after an unexpected crash.
2. **Codex Router** remains the existing Router service task. Its auto-start,
   supervisor, gateway, forwarders, and provider processes are unchanged.

Stopping or restarting `Codex Router` never targets the manager task. Quitting
or uninstalling the manager never implicitly stops Router traffic.

The installed Router launcher receives an explicit standalone-manager
environment flag. With that flag, `router.mjs` does not bind port 4111. Without
the flag, the existing embedded `startTaskManagerUi()` path remains intact.
This preserves non-Windows behavior, tests, and developer checkouts while
preventing two installed processes from racing for the same port.

## Manager host and UI

A standalone host owns the HTTP listener and reuses the existing HTML, usage
page, converter, pricing, and Task Manager API behavior. It adds:

- a manager-only health endpoint used by install and doctor;
- Router service status;
- Start, Stop, and Restart actions;
- Router runtime-state retrieval;
- operation progress and last-result state.

The UI represents Router lifecycle as `stopped`, `starting`, `running`,
`unhealthy`, `stopping`, `restarting`, or `failed`. Start is available while
stopped. Stop and Restart are available while running or unhealthy and require
confirmation. All three controls are disabled while another service mutation
is active.

Service mutations call the repository's existing `service.mjs` commands with a
fixed allowlist. They do not accept a command, executable, path, task name, or
extra argument from HTTP input. The existing service-operation lock remains
the authority for cross-process serialization.

## Data ownership and synchronization

The shared private Task Manager configuration file remains the durable source
for enabled state, CTM port/token selection, account pool, blocked accounts,
Fast account IDs, retry settings, intervals, and panel preferences.

The Router process remains authoritative for volatile routing state:

- active injected credential;
- hydrated pool credentials and cursor;
- recent failures and failover state;
- recent injection events and counters.

The independent host must not present its own process-local bridge cache as
Router state. Instead, Router exposes two caller-authenticated internal
operations on its existing loopback surface:

- a read-only runtime snapshot for the manager UI;
- a bounded Task Manager reload that refreshes the active account and pool
  after an online configuration mutation.

When Router is online, the manager writes or performs the requested Task
Manager change and then requests an immediate Router reload. The UI refreshes
from the Router runtime snapshot, so account switching and pool changes do not
wait for the current 15-second poll.

When Router is offline, durable configuration changes remain allowed and are
loaded on the next Router start. Volatile fields are explicitly reported as
offline or unavailable; stale manager-process values are never substituted.
If an online proxy or reload fails after a mutation, the UI reports that the
configuration was saved but runtime refresh was not confirmed.

Local-router model sync and prune continue rebuilding the catalog. In
standalone mode they invoke the Router service restart after the HTTP response
is committed; they never terminate the manager process. Embedded mode retains
its current Router-process restart behavior.

## Local security boundary

The manager binds only to `127.0.0.1`. Loopback binding alone is insufficient
for an HTTP service that can run current-user service commands, so the manager
reuses the existing Router caller capability and private caller-key file.

The UI and its APIs live below the capability path. The bare port does not
grant a session or reveal the capability. A new `task-manager open` control
command reads the current capability and opens the correct URL. The Windows
installer creates a current-user Start Menu shortcut that invokes this command
silently, so capability rotation does not leave a stale URL in the shortcut.
The background task never opens the browser itself.

Mutating requests additionally require same-origin browser metadata and JSON
content. The server sends no permissive CORS headers and uses no-store,
no-referrer, and frame-denial response policy. Service actions are restricted
to the fixed allowlist and are serialized.

Errors returned to the page or written to logs are bounded and redacted. They
must not include the caller capability, CTM token, account access token,
provider credential, managed URL, command environment, or upstream response
body.

## Windows installation transaction

The independent manager is installed as part of the Windows Codex target after
its package and deterministic checks are ready. The transaction is:

1. Snapshot the current Router task/launcher state and any recognized manager
   task.
2. Prepare the manager launcher, task definition, shortcut, and standalone
   Router launcher without starting either replacement.
3. Stop the Router task to release port 4111.
4. Register and start the manager task; wait for manager health on port 4111.
5. Register and start the Router with standalone mode enabled; wait for gateway
   and Router health on ports 4200 and 4202.
6. Commit the new task and launcher state only after both health contracts pass.

An unknown listener on port 4111 is never terminated. Installation stops with
an ownership diagnostic before mutating tasks.

If any transaction step fails, installation removes only artifacts created by
that attempt, restores the prior Router task and launcher, starts Router in its
previous embedded-UI mode, and verifies Router health before reporting the
failure. The existing Control Center task and package are outside this
transaction and remain untouched.

Update and repair refresh both recognized tasks while preserving current-user
ownership and limited run level. Uninstall removes the manager task and
shortcut, removes the standalone flag from the Router launcher, starts Router
with its embedded UI restored, and verifies port 4111 and Router health.

## Failure handling

- **Router crashes or is unhealthy:** the manager stays available and offers
  Restart. Task Scheduler may also recover Router independently.
- **Router is deliberately stopped:** the manager reports Stopped and offers
  Start.
- **Manager crashes:** Task Scheduler retries it; Router traffic is unaffected.
- **Manager cannot bind 4111:** it exits with an ownership-safe diagnostic;
  doctor reports the failed manager health contract.
- **Service command times out:** the operation becomes Failed, controls are
  re-enabled, and a fresh status probe determines the displayed state.
- **Router reload fails after a saved change:** the UI distinguishes saved
  configuration from unconfirmed live activation.
- **Task Scheduler is unreadable:** status is Unknown, not Stopped, and no
  destructive replacement is attempted.

## Doctor and command surface

Windows doctor verifies:

- the standalone-mode marker agrees with the installed task topology;
- the manager task is recognized, current-user-owned, running, and healthy;
- the Router task remains recognized and healthy;
- the reused caller key and Task Manager private state files have
  current-user-only ACLs;
- the configured control port is owned by the recognized manager process.

The control CLI gains a
`task-manager service status|start|stop|restart|install|uninstall` subgroup plus
`task-manager open`. Existing `task-manager status`, `task-manager enable`, and
account configuration commands retain their meanings; enabling the CTM bridge
does not install or start the manager service.

## Verification

Focused unit and integration tests must prove:

1. Service actions accept only Start, Stop, and Restart and execute serially.
2. Capability, origin, method, and content-type failures reject mutations.
3. Status maps scheduler and health results to every UI lifecycle state.
4. The manager PID remains unchanged while an isolated fake Router stops,
   starts, and restarts.
5. Online account and pool changes trigger immediate Router reload; offline
   changes are loaded on the next start.
6. Runtime telemetry comes from Router and becomes explicitly unavailable when
   Router is offline.
7. Model sync restarts Router without exiting the standalone manager.
8. Windows task rendering uses the exact hidden launcher, current-user limited
   principal, login trigger, crash retry, and IgnoreNew instance policy.
9. Install failure restores the prior embedded Router and leaves Control Center
   untouched.
10. Unknown port ownership is refused without terminating a process.
11. Uninstall restores embedded port-4111 behavior.
12. Non-Windows and unmarked development starts preserve the current embedded
    UI.

Expanded verification includes root syntax/lint checks, relevant routing,
Task Manager, service, Windows installer, doctor, and Control Center tests,
`git diff --check`, untracked-file review, and the repository-maintainer final
diff audit. Tests use temporary ports, fake services, and rendered task
definitions rather than mutating the real Task Scheduler.

Final local deployment performs one controlled service transition after all
deterministic checks pass. It verifies manager health on 4111, gateway health
on 4200, Router health on 4202, recognized task/process ownership, and Router
traffic recovery. A real Stop-and-wait test is not run inside the active Codex
turn because that turn depends on Router; the isolated integration test covers
the contract, and the operator can exercise the visible Stop and Start buttons
after deployment.

## Acceptance criteria

- The Task Manager page remains reachable while Router is stopped.
- Start returns Router to healthy service without restarting the manager.
- Restart replaces Router processes without replacing the manager process.
- Stop leaves the manager healthy and clearly reports Router as stopped.
- Existing account selection, pool, failover, native/injected Fast display,
  usage, pricing, and local model operations retain their behavior.
- No unauthenticated local request can invoke service control or read private
  Task Manager state.
- A failed install restores a healthy Router with the previous embedded UI.
- Any existing Control Center installation remains operational and independent.
- Windows login starts both tasks without opening a browser window.
