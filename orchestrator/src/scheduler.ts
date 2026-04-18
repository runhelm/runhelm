import { db } from "./db.js";
import { bus, type BusEvent } from "./bus.js";
import { sendToWorker } from "./workers.js";
import {
  commitWip,
  commitWipAndPush,
  ensureBranchFromBase,
  fetchInRepo,
  gitInRepo,
  hasUncommitted,
  mergeBranchInto,
  pushBranch,
  switchToTicketBranch,
} from "./git.js";
import {
  addComment,
  getActiveTicket,
  getNextBacklog,
  getNextResumable,
  getTicket,
  listComments,
  setTicketStatus,
  type Ticket,
} from "./tickets.js";
import { getActiveSprint, getSprint, sprintTicketStats, updateSprint } from "./sprints.js";

const AWAIT_TIMEOUT_MS = 10 * 60 * 1000;

type ProjectRow = {
  id: string;
  slug: string;
  upstream_repo: string | null;
  upstream_default_branch: string | null;
};

type AwaitState = {
  ticketId: string;
  reason: "ask" | "permission";
  permissionRequestId?: string;
  timer: NodeJS.Timeout;
};

const awaits = new Map<string, AwaitState>(); // ticketId → state
const lastAssistantByProject = new Map<string, string>();
const transitionLocks = new Map<string, Promise<void>>(); // projectId → lock
const pendingPermProject = new Map<string, string>(); // requestId → projectId
const prevStatusByProject = new Map<string, string>();

export function startScheduler(): void {
  bus.on(handleBusEvent);
  // Crash-recovery: re-arm timers & flush overdue awaits
  setTimeout(() => {
    recoverOnBoot().catch((err) =>
      console.error("[scheduler] recovery failed", err)
    );
  }, 500);
}

function handleBusEvent(e: BusEvent): void {
  if (e.type === "worker_status") {
    const prev = prevStatusByProject.get(e.projectId);
    prevStatusByProject.set(e.projectId, e.status);
    if (e.status === "idle") {
      const isTurnEnd = prev === "running" || prev === "waiting_permission";
      serial(e.projectId, () =>
        onWorkerIdle(e.projectId, isTurnEnd)
      ).catch((err) =>
        console.error("[scheduler] worker_idle handling failed", err)
      );
    }
    return;
  }
  if (e.type === "worker_message" && e.role === "assistant") {
    lastAssistantByProject.set(e.projectId, e.text ?? "");
    // Also mirror into ticket comments if there's an active in_progress ticket
    const active = getActiveInProgress(e.projectId);
    if (active) {
      addComment(active.id, "assistant", e.text ?? "", "scheduler").catch(
        (err) => console.error("[scheduler] addComment failed", err)
      );
    }
    return;
  }
  if (e.type === "permission_request") {
    const active = getActiveInProgress(e.projectId);
    if (!active) return;
    pendingPermProject.set(e.requestId, e.projectId);
    startAwait(active.id, "permission", e.requestId);
    addComment(
      active.id,
      "permission",
      `Tool: ${e.tool}`,
      "scheduler"
    ).catch(() => {});
    return;
  }
  if (e.type === "permission_resolved") {
    const projectId = pendingPermProject.get(e.requestId);
    if (projectId) pendingPermProject.delete(e.requestId);
    // cancel any await waiting on this permission
    for (const [ticketId, st] of awaits) {
      if (st.reason === "permission" && st.permissionRequestId === e.requestId) {
        clearTimeout(st.timer);
        awaits.delete(ticketId);
        const t = getTicket(ticketId);
        if (t && t.status === "awaiting_reply") {
          setTicketStatus(ticketId, "in_progress");
        }
        break;
      }
    }
    return;
  }
  if (e.type === "ticket_comment_added" && e.role === "user") {
    serial(e.projectId, () =>
      onUserTicketReply(e.projectId, e.ticketId, e.text, e.origin)
    ).catch((err) =>
      console.error("[scheduler] ticket reply handling failed", err)
    );
    return;
  }
  if (e.type === "ticket_changed") {
    // A new ticket (or edited priority) might deserve scheduling now.
    serial(e.projectId, () => scheduleNext(e.projectId)).catch((err) =>
      console.error("[scheduler] ticket_changed scheduling failed", err)
    );
    return;
  }
  if (e.type === "sprint_changed") {
    // A sprint transitioning to active might unblock scheduling.
    serial(e.projectId, () => scheduleNext(e.projectId)).catch((err) =>
      console.error("[scheduler] sprint_changed scheduling failed", err)
    );
    return;
  }
}

function serial<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = transitionLocks.get(projectId) ?? Promise.resolve();
  const next = prev.then(fn).catch((err) => {
    console.error("[scheduler] serial task error", err);
  }) as unknown as Promise<T>;
  transitionLocks.set(
    projectId,
    next.then(() => {}).catch(() => {})
  );
  return next;
}

function getActiveInProgress(projectId: string): Ticket | null {
  return (
    (db
      .prepare(
        "SELECT * FROM tickets WHERE project_id = ? AND status = 'in_progress' LIMIT 1"
      )
      .get(projectId) as Ticket | undefined) ?? null
  );
}

function getAwaitingForActive(projectId: string): Ticket | null {
  // The most recent awaiting ticket for this project (not necessarily resumable)
  return (
    (db
      .prepare(
        "SELECT * FROM tickets WHERE project_id = ? AND status = 'awaiting_reply' ORDER BY updated_at DESC LIMIT 1"
      )
      .get(projectId) as Ticket | undefined) ?? null
  );
}

async function onWorkerIdle(
  projectId: string,
  isTurnEnd: boolean
): Promise<void> {
  const active = getActiveInProgress(projectId);
  if (active && isTurnEnd) {
    const project = getProjectRow(projectId);
    const branch = active.branch ?? "?";
    // Persist any uncommitted work + push current state to origin
    if (project && active.branch) {
      try {
        await commitWipAndPush(
          project.slug,
          active.branch,
          `WIP: T-${active.number} ${active.title}`
        );
      } catch (err) {
        console.error("[scheduler] WIP+push at turn end failed", err);
      }
    }

    const msg = lastAssistantByProject.get(projectId) ?? "";
    lastAssistantByProject.delete(projectId);
    if (hasAskMarker(msg)) {
      startAwait(active.id, "ask");
      setTicketStatus(active.id, "awaiting_reply", {
        awaitingSince: Date.now(),
      });
      await addComment(
        active.id,
        "system",
        `⏸ Wartet auf Antwort — Stand auf \`${branch}\` gepusht.`,
        "scheduler"
      );
      return;
    }
    // Worker fertig — auf User-Abnahme warten
    setTicketStatus(active.id, "ready_for_testing");
    await addComment(
      active.id,
      "system",
      `🧪 Bereit zum Test auf Branch \`${branch}\` — User-Abnahme via Button.`,
      "scheduler"
    );
    await scheduleNext(projectId);
    return;
  }
  if (!active) {
    // Worker is idle and no ticket is active — try picking the next
    await scheduleNext(projectId);
  }
  // else: active ticket exists but this idle isn't a turn-end (e.g. boot/hello) → ignore
}

function hasAskMarker(text: string): boolean {
  if (!text) return false;
  // [ASK] at start of any line
  return /(^|\n)\s*\[ASK\]\b/.test(text);
}

function startAwait(
  ticketId: string,
  reason: "ask" | "permission",
  permissionRequestId?: string
): void {
  const existing = awaits.get(ticketId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    onAwaitTimeout(ticketId).catch((err) =>
      console.error("[scheduler] await timeout handler failed", err)
    );
  }, AWAIT_TIMEOUT_MS);
  awaits.set(ticketId, { ticketId, reason, permissionRequestId, timer });
}

async function onAwaitTimeout(ticketId: string): Promise<void> {
  const st = awaits.get(ticketId);
  if (!st) return;
  awaits.delete(ticketId);
  const t = getTicket(ticketId);
  if (!t) return;

  if (st.reason === "permission" && st.permissionRequestId) {
    // auto-deny to unblock worker
    bus.emit({
      type: "permission_resolved",
      requestId: st.permissionRequestId,
      allow: false,
      note: "Timeout — Ticket pausiert, Worker fährt mit nächstem fort.",
    });
    // give worker a moment to go idle
    setTimeout(() => {
      serial(t.project_id, () => rotateAfterTimeout(ticketId)).catch((err) =>
        console.error("[scheduler] rotation after perm timeout failed", err)
      );
    }, 1500);
    return;
  }

  await serial(t.project_id, () => rotateAfterTimeout(ticketId));
}

async function rotateAfterTimeout(ticketId: string): Promise<void> {
  const t = getTicket(ticketId);
  if (!t) return;
  const project = getProjectRow(t.project_id);
  if (!project) return;

  try {
    if (t.branch) {
      const did = await commitWipAndPush(
        project.slug,
        t.branch,
        `WIP: T-${t.number} ${t.title} (Timeout)`
      );
      await addComment(
        t.id,
        "system",
        did
          ? `⏱ Timeout — WIP+push auf \`${t.branch}\`. Ticket pausiert.`
          : `⏱ Timeout — kein neuer Commit, Stand auf \`${t.branch}\` gepusht. Ticket pausiert.`,
        "scheduler"
      );
    } else {
      await addComment(t.id, "system", `⏱ Timeout — Ticket pausiert.`, "scheduler");
    }
  } catch (err) {
    console.error("[scheduler] WIP+push failed", err);
  }

  // Ticket stays awaiting_reply (auto_resume=0 — user hasn't replied yet)
  await scheduleNext(t.project_id);
}

async function onUserTicketReply(
  projectId: string,
  ticketId: string,
  text: string,
  origin: string
): Promise<void> {
  const t = getTicket(ticketId);
  if (!t) return;

  // Cancel any await timer for this ticket
  const aw = awaits.get(ticketId);
  if (aw) {
    clearTimeout(aw.timer);
    awaits.delete(ticketId);
    if (aw.reason === "permission" && aw.permissionRequestId) {
      // user replied but didn't answer the permission; we still deny to unblock,
      // then let the user's text drive the next turn after worker idles.
      bus.emit({
        type: "permission_resolved",
        requestId: aw.permissionRequestId,
        allow: false,
        note: "User antwortete stattdessen per Text.",
      });
    }
  }

  const active = getActiveInProgress(projectId);
  if (active && active.id === ticketId) {
    // Active ticket — forward as next prompt once idle (or now if idle)
    await sendTicketPrompt(t, text, /* resume */ false);
    return;
  }
  if (t.status === "awaiting_reply") {
    // Not the currently-active ticket, or none active
    if (!active) {
      // Resume it now
      await resumeTicket(t, text);
      return;
    }
    // Another ticket is running; queue for later
    setTicketStatus(ticketId, "awaiting_reply", { autoResume: 1 });
    await addComment(
      ticketId,
      "system",
      `📥 Antwort vorgemerkt — wird übernommen, sobald aktuelles Ticket fertig ist.`,
      "scheduler"
    );
    return;
  }
  if (t.status === "backlog") {
    // Treat as description edit / additional context — just store comment.
    return;
  }
}

async function scheduleNext(projectId: string): Promise<void> {
  const existing = getActiveInProgress(projectId);
  if (existing) return; // already busy

  const sprint = getActiveSprint(projectId);
  if (!sprint) return; // no active sprint → tickets are gated

  // Priority: backlog first
  let next = getNextBacklog(projectId, sprint.id);
  if (!next) {
    const resumable = getNextResumable(projectId, sprint.id);
    if (resumable) {
      await resumeTicket(resumable, null);
      return;
    }
    return;
  }

  await startTicket(next);
}

async function startTicket(t: Ticket): Promise<void> {
  const project = getProjectRow(t.project_id);
  if (!project) return;
  const worker = getWorkerId(t.project_id);
  if (!worker) {
    await addComment(
      t.id,
      "system",
      `⚠️ Kein laufender Worker — Ticket bleibt im Backlog.`,
      "scheduler"
    );
    return;
  }

  const branch = t.branch ?? `claude/t-${t.number}`;
  const baseRef = await resolveTicketBaseRef(project, t);
  try {
    // Commit any stray work on the current branch first
    await commitWip(project.slug, `WIP before ticket T-${t.number}`);
    await fetchInRepo(project.slug, ["fetch", "--all", "--prune"]);
    await switchToTicketBranch(project.slug, branch, baseRef);
  } catch (err) {
    console.error("[scheduler] branch setup failed", err);
    await addComment(
      t.id,
      "system",
      `⚠️ Branch-Setup fehlgeschlagen: ${(err as Error).message}`,
      "scheduler"
    );
    return;
  }

  setTicketStatus(t.id, "in_progress", {
    branch,
    startedAt: Date.now(),
  });

  // reset worker session so each ticket gets a fresh Claude context
  sendToWorker(worker, { type: "reset_session" });

  const prompt = buildInitialPrompt(t);
  await addComment(
    t.id,
    "system",
    `▶️ Gestartet auf Branch \`${branch}\`.`,
    "scheduler"
  );
  bus.emit({
    type: "user_prompt",
    workerId: worker,
    projectId: t.project_id,
    text: prompt,
    origin: "scheduler",
    ticketId: t.id,
  });
}

async function resumeTicket(t: Ticket, userReply: string | null): Promise<void> {
  const project = getProjectRow(t.project_id);
  if (!project) return;
  const worker = getWorkerId(t.project_id);
  if (!worker) return;

  const branch = t.branch ?? `claude/t-${t.number}`;
  const baseRef = await resolveTicketBaseRef(project, t);
  try {
    await commitWip(project.slug, `WIP before resume T-${t.number}`);
    await fetchInRepo(project.slug, ["fetch", "--all", "--prune"]);
    await switchToTicketBranch(project.slug, branch, baseRef);
  } catch (err) {
    console.error("[scheduler] resume branch setup failed", err);
    await addComment(
      t.id,
      "system",
      `⚠️ Branch-Setup bei Resume fehlgeschlagen: ${(err as Error).message}`,
      "scheduler"
    );
    return;
  }

  setTicketStatus(t.id, "in_progress", { branch, autoResume: 0 });

  sendToWorker(worker, { type: "reset_session" });

  const prompt = buildResumePrompt(t, userReply);
  await addComment(
    t.id,
    "system",
    `↪️ Weitergeführt auf Branch \`${branch}\`.`,
    "scheduler"
  );
  bus.emit({
    type: "user_prompt",
    workerId: worker,
    projectId: t.project_id,
    text: prompt,
    origin: "scheduler",
    ticketId: t.id,
  });
}

async function sendTicketPrompt(
  t: Ticket,
  text: string,
  _resume: boolean
): Promise<void> {
  const worker = getWorkerId(t.project_id);
  if (!worker) return;
  // Ensure ticket stays in_progress (covers the awaiting_reply → in_progress case)
  if (t.status !== "in_progress") {
    setTicketStatus(t.id, "in_progress", { autoResume: 0 });
  }
  bus.emit({
    type: "user_prompt",
    workerId: worker,
    projectId: t.project_id,
    text,
    origin: "scheduler",
    ticketId: t.id,
  });
}

function buildInitialPrompt(t: Ticket): string {
  return [
    `Du arbeitest an Ticket T-${t.number}: ${t.title}.`,
    t.description ? `\nBeschreibung:\n${t.description}` : "",
    ``,
    `WICHTIG:`,
    `- Wenn du zusätzliche Info vom User brauchst, beginne deine Antwort mit einer`,
    `  einzelnen Zeile: [ASK]`,
    `  Danach stelle die konkrete Frage. Arbeite NICHT weiter bis eine Antwort kommt.`,
    `- Wenn das Ticket abgeschlossen ist, gib eine kurze Zusammenfassung (ohne [ASK]).`,
    `- Committe deine Änderungen sinnvoll mit git.`,
    `- Wenn du ein Mockup, Bild oder HTML erzeugst, schreibe es ins Repo (in /workspace)`,
    `  und referenziere es in deiner Antwort mit \`[[preview:<pfad/relativ/zum/repo>]]\`.`,
    `  Die WebUI bettet HTML/SVG/PNG/JPG/GIF/WebP dann direkt als Vorschau ein.`,
    ``,
    `Leg los.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildResumePrompt(t: Ticket, userReply: string | null): string {
  const comments = listComments(t.id)
    .filter((c) => c.role === "assistant" || c.role === "user")
    .slice(-20);
  const history = comments
    .map((c) => `[${c.role}] ${c.text.slice(0, 1500)}`)
    .join("\n\n");
  return [
    `Du machst an Ticket T-${t.number}: ${t.title} weiter.`,
    t.description ? `\nBeschreibung:\n${t.description}` : "",
    ``,
    `Bisheriger Verlauf (gekürzt):`,
    history || "(leer)",
    ``,
    userReply ? `Neue User-Antwort:\n${userReply}\n` : "",
    `Gleiche Regeln: [ASK] falls nötig, sonst weitermachen + kurze Zusammenfassung am Ende.`,
    `Du bist auf Branch \`${t.branch ?? "?"}\`. Die bisherigen Commits sind vorhanden (inkl. WIP).`,
  ]
    .filter(Boolean)
    .join("\n");
}

function getProjectRow(projectId: string): ProjectRow | null {
  return (
    (db
      .prepare(
        "SELECT id, slug, upstream_repo, upstream_default_branch FROM projects WHERE id = ?"
      )
      .get(projectId) as ProjectRow | undefined) ?? null
  );
}

function getWorkerId(projectId: string): string | null {
  const row = db
    .prepare<[string], { id: string }>(
      "SELECT id FROM workers WHERE project_id = ? AND status NOT IN ('stopped','error') ORDER BY created_at DESC LIMIT 1"
    )
    .get(projectId);
  return row?.id ?? null;
}

async function resolveTicketBaseRef(
  project: ProjectRow,
  t: Ticket
): Promise<string> {
  if (t.sprint_id) {
    const sprint = getSprint(t.sprint_id);
    if (sprint) {
      // Make sure local sprint branch is set up & up-to-date
      try {
        await fetchInRepo(project.slug, ["fetch", "origin"]);
        await gitInRepo(project.slug, [
          "rev-parse",
          "--verify",
          `origin/${sprint.branch}`,
        ]);
        return `origin/${sprint.branch}`;
      } catch {
        // sprint branch not yet pushed — should not happen post-start, but fall back
      }
    }
  }
  return resolveBaseRef(project);
}

async function resolveBaseRef(project: ProjectRow): Promise<string> {
  if (project.upstream_repo && project.upstream_default_branch) {
    return `upstream/${project.upstream_default_branch}`;
  }
  try {
    const head = await gitInRepo(project.slug, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
    ]);
    // e.g. "refs/remotes/origin/main"
    const m = head.match(/refs\/remotes\/origin\/(.+)$/);
    if (m) return `origin/${m[1]}`;
  } catch {
    // ignore
  }
  return "origin/main";
}

async function recoverOnBoot(): Promise<void> {
  // Expire overdue awaits; re-arm timers for recent ones
  const now = Date.now();
  const awaiting = db
    .prepare(
      "SELECT * FROM tickets WHERE status = 'awaiting_reply' AND awaiting_since IS NOT NULL"
    )
    .all() as Ticket[];
  for (const t of awaiting) {
    const elapsed = now - (t.awaiting_since ?? now);
    if (elapsed >= AWAIT_TIMEOUT_MS) {
      // Pretend the timer fired
      const project = getProjectRow(t.project_id);
      if (!project) continue;
      try {
        if (t.branch) {
          await commitWipAndPush(
            project.slug,
            t.branch,
            `WIP: T-${t.number} ${t.title} (Restart-Recovery)`
          );
        }
      } catch (err) {
        console.error("[scheduler] recovery WIP+push failed", err);
      }
    } else {
      // Re-arm for the remaining time
      const remaining = AWAIT_TIMEOUT_MS - elapsed;
      const timer = setTimeout(() => {
        onAwaitTimeout(t.id).catch(() => {});
      }, remaining);
      awaits.set(t.id, { ticketId: t.id, reason: "ask", timer });
    }
  }
  // Trigger a scheduling pass per project with running workers
  const projects = db
    .prepare("SELECT DISTINCT project_id AS id FROM workers WHERE status NOT IN ('stopped','error')")
    .all() as Array<{ id: string }>;
  for (const p of projects) {
    serial(p.id, () => scheduleNext(p.id)).catch(() => {});
  }
}

export { getActiveTicket };

/**
 * Notify a running worker that the ticket description has been edited.
 * Adds a system comment and, if the ticket is currently in_progress,
 * forwards an update prompt so the AI picks up the new description.
 */
export async function notifyTicketDescriptionChanged(
  ticketId: string
): Promise<void> {
  const t = getTicket(ticketId);
  if (!t) return;
  if (t.status !== "in_progress" && t.status !== "awaiting_reply") return;

  const desc = t.description?.trim() ? t.description : "(leer)";
  const body = [
    `Die Ticket-Beschreibung wurde vom User aktualisiert. Bitte berücksichtige die neue Fassung in deiner weiteren Arbeit.`,
    ``,
    `Neue Beschreibung:`,
    desc,
  ].join("\n");

  await addComment(ticketId, "system", `📝 Beschreibung aktualisiert.`, "ui");

  const worker = getWorkerId(t.project_id);
  if (!worker) return;
  const active = getActiveInProgress(t.project_id);
  if (!active || active.id !== ticketId) return;

  bus.emit({
    type: "user_prompt",
    workerId: worker,
    projectId: t.project_id,
    text: body,
    origin: "scheduler",
    ticketId: t.id,
  });
}

/**
 * Start a sprint: create the sprint branch from the project's base ref,
 * push it to origin, and flip status active.
 */
export async function startSprint(sprintId: string): Promise<void> {
  const sprint = getSprint(sprintId);
  if (!sprint) throw new Error("Sprint nicht gefunden");
  if (sprint.status !== "planning")
    throw new Error(`Sprint ist bereits ${sprint.status}`);
  const project = getProjectRow(sprint.project_id);
  if (!project) throw new Error("Projekt nicht gefunden");

  const other = getActiveSprint(sprint.project_id);
  if (other && other.id !== sprint.id) {
    throw new Error(
      `Es gibt bereits einen aktiven Sprint: "${other.name}". Bitte zuerst freigeben.`
    );
  }

  const baseRef = await resolveBaseRef(project);
  await ensureBranchFromBase(project.slug, sprint.branch, baseRef);
  updateSprint(sprintId, { status: "active" });
  await serial(sprint.project_id, () => scheduleNext(sprint.project_id));
}

/**
 * Release a sprint: open a PR sprint-branch → main (or upstream main).
 */
export async function releaseSprint(
  sprintId: string,
  prTitle?: string,
  prBody?: string
): Promise<{ url: string; number: number }> {
  const sprint = getSprint(sprintId);
  if (!sprint) throw new Error("Sprint nicht gefunden");
  if (sprint.status !== "pending_release" && sprint.status !== "active") {
    throw new Error(`Sprint ist im Status ${sprint.status}, nicht release-bar`);
  }

  const { openSprintPullRequest } = await import("./git.js");
  const title = prTitle ?? `Sprint: ${sprint.name}`;
  const body = prBody ?? `Sprint-Release \`${sprint.name}\` (Branch \`${sprint.branch}\`)`;
  const pr = await openSprintPullRequest(sprint.project_id, sprint.branch, title, body);

  updateSprint(sprintId, {
    status: "released",
    pr_url: pr.url,
    pr_number: pr.number,
  });
  return pr;
}

/**
 * User-driven ticket acceptance: merge ticket branch into sprint branch,
 * mark ticket done, and flip sprint to pending_release if everything is done.
 */
export async function acceptTicket(ticketId: string): Promise<void> {
  const t = getTicket(ticketId);
  if (!t) throw new Error("Ticket nicht gefunden");
  if (t.status !== "ready_for_testing") {
    throw new Error(
      `Ticket ist im Status ${t.status} — nur 'ready_for_testing' kann abgenommen werden.`
    );
  }
  const project = getProjectRow(t.project_id);
  if (!project) throw new Error("Projekt nicht gefunden");
  if (!t.sprint_id) throw new Error("Ticket ist keinem Sprint zugeordnet");
  const sprint = getSprint(t.sprint_id);
  if (!sprint) throw new Error("Sprint nicht gefunden");
  if (!t.branch) throw new Error("Ticket hat keinen Branch");

  // ensure latest WIP is committed + pushed first
  await commitWipAndPush(
    project.slug,
    t.branch,
    `WIP: T-${t.number} ${t.title} (vor Abnahme)`
  );
  await mergeBranchInto(
    project.slug,
    t.branch,
    sprint.branch,
    `Merge T-${t.number}: ${t.title} into sprint ${sprint.name}`
  );

  setTicketStatus(ticketId, "done", { completedAt: Date.now() });
  await addComment(
    ticketId,
    "system",
    `✅ Abgenommen — \`${t.branch}\` → \`${sprint.branch}\` gemerged.`,
    "ui"
  );

  // sprint completion
  const stats = sprintTicketStats(sprint.id);
  if (stats.total > 0 && stats.open === 0 && sprint.status === "active") {
    updateSprint(sprint.id, { status: "pending_release" });
  }

  await serial(t.project_id, () => scheduleNext(t.project_id));
}
