# Independent Task Manager Follow-Up Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Close the two load-bearing residuals from the final scoped review without changing the reviewed Windows standalone topology.

**Architecture:** Tighten doctor applicability so N/A is possible only after every manager, topology, listener, and config signal is proven absent. Make the opener platform-aware: capability-bearing standalone URLs still require strict Windows ownership, while capability-free embedded roots remain available on POSIX and uninstalled Windows development checkouts.

**Tech Stack:** Node.js 24 ESM, built-in HTTP/process helpers, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-26-independent-task-manager-service-design.md`

## Global Constraints

- Do not mutate real Task Scheduler, services, shortcuts, PIDs, browser state, or the installed checkout.
- Reuse existing marker/status/listener/process helpers; add no dependency.
- Never read or disclose caller capability for a capability-free embedded URL.
- Installed Windows standalone ownership remains strict and unchanged.
- Public health contracts, Control Center, and unrelated baselines remain unchanged.
- Each task uses TDD, one focused Conventional Commit, task review, and parent verification.

---

### Task 1: Make doctor N/A require proven absence

**Files:**
- Modify: `src/task-manager-doctor.mjs`
- Modify: `src/doctor.mjs` only if evidence wiring requires it
- Modify: `test/doctor-task-manager.test.mjs`

**Interface:** Consume marker state, manager service/components, manager health/listener evidence, protected Router mode, and Task Manager config existence/privacy. Return `[]` only for a genuine no-installation state.

- [ ] **Step 1: Write failing drift tests**

Add cases proving rows are emitted when marker is missing or disabled but any one of these is true: Router mode is standalone; manager health answers; listener is present; service/components are present; or `task-manager.json` exists. Existing unprotected config must fail `Task Manager privacy`.

Keep one true N/A fixture: marker missing or disabled, Router embedded or unknown, manager health unavailable, listener absent, all task/launcher/shortcut/process components absent, and config absent.

- [ ] **Step 2: Run RED**

```powershell
node --test test/doctor-task-manager.test.mjs
```

Expected: new drift cases fail because the current early return ignores Router, health, listener, and config evidence.

- [ ] **Step 3: Implement the smallest complete applicability predicate**

Evaluate every evidence source before returning N/A. Missing or malformed evidence fails closed when any manager/topology/config signal exists. Never interpolate evidence values into doctor details or remedies.

- [ ] **Step 4: Run GREEN**

```powershell
node --test test/doctor-task-manager.test.mjs test/control-health.test.mjs
npm run check
git diff --check
```

- [ ] **Step 5: Commit**

```powershell
git add src/task-manager-doctor.mjs src/doctor.mjs test/doctor-task-manager.test.mjs
git commit -m "fix(task-manager): diagnose standalone marker drift"
```

---

### Task 2: Preserve platform-aware embedded opener behavior

**Files:**
- Modify: `src/task-manager-open.mjs`
- Modify: existing shared opener/ownership helper only when required
- Modify: `test/task-manager-open.test.mjs`
- Modify: adjacent ownership tests only when shared behavior changes

**Interfaces:**
- Installed Windows standalone: strict canonical task/process/OS-listener/health ownership before caller-secret read.
- Installed Windows embedded: strict recognized Router ownership, then plain root.
- Uninstalled Windows development embedded: exact live listener command for this checkout `src/router.mjs` plus responding HTML root; no Scheduled Task; plain root.
- POSIX embedded: no Windows probes; responding HTML root opens plain root; caller secret is never read.
- POSIX standalone-shaped public health: refuse because independent supervision is Windows-only.

- [ ] **Step 1: Write failing default-path tests**

Exercise `openTaskManager()` without injecting a successful ownership classifier. Cover POSIX embedded, Windows development embedded with no task, and spoofed standalone. Assert embedded paths never call `readCallerSecret`.

- [ ] **Step 2: Run RED**

```powershell
node --test test/task-manager-open.test.mjs
```

Expected: POSIX and uninstalled Windows embedded cases fail because the default path forces the Windows canonical-task classifier.

- [ ] **Step 3: Implement platform-aware classification**

Branch before any caller-secret read. Keep strict installed standalone proof unchanged. Development and POSIX fallback is allowed only for the capability-free embedded root and must never transform standalone-shaped health into a capability URL.

- [ ] **Step 4: Run GREEN and security regressions**

```powershell
node --test test/task-manager-open.test.mjs test/task-manager-install.test.mjs test/task-manager-service-windows.test.mjs test/panel.test.mjs test/caller-auth.test.mjs
node --test test/doctor-task-manager.test.mjs test/control-health.test.mjs
npm run check
git diff --check
```

- [ ] **Step 5: Commit**

```powershell
git add src/task-manager-open.mjs src/task-manager-install.mjs src/windows-listener-owner.mjs test/task-manager-open.test.mjs test/task-manager-install.test.mjs
git commit -m "fix(task-manager): preserve embedded opener fallback"
```

---

## Final follow-up verification

Run affected suites serially, repo-maintainer range analysis, and one final read-only whole-branch review. Do not deploy until that review is clean.
