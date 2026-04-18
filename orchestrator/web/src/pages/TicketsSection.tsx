import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  api,
  type Project,
  type Sprint,
  type Ticket,
  type TicketComment,
  type TicketStatus,
  type TicketType,
  type TicketWithComments,
} from "../api";
import { Icon } from "../Icon";
import { renderMessageContent } from "../previews";

const TYPE_PREFIX: Record<TicketType, string> = { task: "T", bug: "B" };
function ticketPrefix(t: { type?: TicketType }): string {
  return TYPE_PREFIX[t.type ?? "task"];
}

export function TicketsSection({
  projectId,
  version,
}: {
  projectId: string;
  version: number; // bumped on ticket_changed / comment_added events
}) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [sprintFilter, setSprintFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<"all" | TicketType>("all");
  const [hideClosed, setHideClosed] = useState(true);

  const openTicket = (t: Ticket) => {
    location.hash = `/projects/${projectId}/tickets/${t.number}`;
  };

  const refresh = () =>
    api<Ticket[]>(`/api/projects/${projectId}/tickets`)
      .then(setTickets)
      .catch(console.error);

  useEffect(() => {
    refresh();
    api<Sprint[]>(`/api/projects/${projectId}/sprints`)
      .then(setSprints)
      .catch(() => {});
    api<{ colors: Record<string, string> }>("/api/setup/status-colors")
      .then((r) => setColors(r.colors))
      .catch(() => {});
    api<Project>(`/api/projects/${projectId}`)
      .then(setProject)
      .catch(() => {});
  }, [projectId, version]);

  const key = project?.key ?? "";

  const filtered = tickets.filter((t) => {
    if (typeFilter !== "all" && (t.type ?? "task") !== typeFilter) return false;
    if (sprintFilter === "all") return true;
    if (sprintFilter === "none") return !t.sprint_id;
    return t.sprint_id === sprintFilter;
  });

  const open = filtered.filter(
    (t) => t.status !== "done" && t.status !== "cancelled"
  );
  const closed = filtered.filter(
    (t) => t.status === "done" || t.status === "cancelled"
  );

  const sprintById = new Map(sprints.map((s) => [s.id, s]));

  return (
    <div className="card">
      <div className="row" style={{ gap: 10, marginBottom: 10, alignItems: "center" }}>
        <label className="row" style={{ gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>Typ:</span>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as "all" | TicketType)}
          >
            <option value="all">Alle</option>
            <option value="task">Tasks</option>
            <option value="bug">Bugs</option>
          </select>
        </label>
        <label className="row" style={{ gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>Sprint:</span>
          <select
            value={sprintFilter}
            onChange={(e) => setSprintFilter(e.target.value)}
          >
            <option value="all">Alle</option>
            <option value="none">— kein Sprint —</option>
            {sprints.map((s) => (
              <option key={s.id} value={s.id}>
                {key}-S{s.number} {s.name} ({s.status})
              </option>
            ))}
          </select>
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={hideClosed}
            onChange={(e) => setHideClosed(e.target.checked)}
          />
          <span className="muted" style={{ fontSize: 12 }}>geschlossene ausblenden</span>
        </label>
        <span className="subtle" style={{ fontSize: 12 }}>
          {open.length} offen · {closed.length} geschlossen
        </span>
        <button onClick={() => setCreating(true)} style={{ marginLeft: "auto" }}>
          <Icon name="plus" size={13} /> Neu
        </button>
      </div>

      {tickets.length === 0 && (
        <div className="muted" style={{ fontSize: 13, padding: "8px 0" }}>
          Keine Tickets. Leg eines an, damit die KI priorisiert arbeiten kann.
        </div>
      )}

      {open.length > 0 && (
        <div className="ticket-list">
          {open.map((t) => (
            <TicketRow
              key={t.id}
              t={t}
              projectKey={key}
              sprint={t.sprint_id ? sprintById.get(t.sprint_id) : undefined}
              colors={colors}
              onOpen={() => openTicket(t)}
            />
          ))}
        </div>
      )}

      {!hideClosed && closed.length > 0 && (
        <>
          <h3 style={{ marginTop: 18, marginBottom: 8 }}>
            Geschlossen <span className="subtle">({closed.length})</span>
          </h3>
          <div className="ticket-list">
            {closed.map((t) => (
              <TicketRow
                key={t.id}
                t={t}
                sprint={t.sprint_id ? sprintById.get(t.sprint_id) : undefined}
                onOpen={() => openTicket(t)}
              />
            ))}
          </div>
        </>
      )}

      {creating && (
        <CreateTicketDialog
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}

    </div>
  );
}

export const STATUS_LABEL: Record<TicketStatus, string> = {
  backlog: "backlog",
  in_progress: "läuft",
  awaiting_reply: "wartet",
  ready_for_testing: "ready for test",
  done: "done",
  cancelled: "abgebrochen",
};

export const ALL_STATUSES: TicketStatus[] = [
  "backlog",
  "in_progress",
  "awaiting_reply",
  "ready_for_testing",
  "done",
  "cancelled",
];

function statusBadge(s: TicketStatus): { label: string; cls: string; pulse?: boolean } {
  const pulse = s === "in_progress" || s === "awaiting_reply" || s === "ready_for_testing";
  return { label: STATUS_LABEL[s], cls: "", pulse };
}

function statusBadgeStyle(s: TicketStatus, colors: Record<string, string>): CSSProperties {
  const bg = colors[s] ?? "#64748b";
  return {
    background: bg,
    color: "#fff",
    border: "none",
  };
}

function priorityLabel(p: number): { label: string; cls: string } {
  if (p <= 30) return { label: "hoch", cls: "err" };
  if (p >= 70) return { label: "niedrig", cls: "" };
  return { label: "mittel", cls: "warn" };
}

function TicketRow({
  t,
  projectKey,
  sprint,
  colors,
  onOpen,
}: {
  t: Ticket;
  projectKey: string;
  sprint?: Sprint;
  colors: Record<string, string>;
  onOpen: () => void;
}) {
  const st = statusBadge(t.status);
  const prio = priorityLabel(t.priority);
  const isBug = (t.type ?? "task") === "bug";
  return (
    <div className="ticket-row" onClick={onOpen}>
      <div className="ticket-main">
        <div className="ticket-title">
          <code className={`ticket-id${isBug ? " ticket-id-bug" : ""}`}>
            {projectKey}-{ticketPrefix(t)}{t.number}
          </code>
          <span>{t.title}</span>
        </div>
        <div className="ticket-branch" style={{ gap: 10, flexWrap: "wrap" }}>
          {sprint && (
            <span className="chip subtle" style={{ fontSize: 11 }}>
              <Icon name="git-branch" size={10} /> {projectKey}-S{sprint.number} {sprint.name}
            </span>
          )}
          {!sprint && !t.sprint_id && (
            <span className="chip subtle" style={{ fontSize: 11, opacity: 0.6 }}>
              kein Sprint
            </span>
          )}
          {t.branch && (
            <span className="subtle" style={{ fontSize: 11 }}>
              <Icon name="git-branch" size={10} /> {t.branch}
            </span>
          )}
        </div>
      </div>
      <div className="row" style={{ gap: 6, flexShrink: 0 }}>
        <span className={`badge ${prio.cls}`} style={{ fontSize: 10 }}>
          {prio.label}
        </span>
        <span
          className={`badge ${st.pulse ? "badge-pulse" : ""}`}
          style={statusBadgeStyle(t.status, colors)}
        >
          {st.label}
        </span>
      </div>
    </div>
  );
}

function CreateTicketDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<"hoch" | "mittel" | "niedrig">("mittel");
  const [type, setType] = useState<TicketType>("task");
  const [sprintId, setSprintId] = useState<string>("");
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Sprint[]>(`/api/projects/${projectId}/sprints`)
      .then((all) => {
        const assignable = all.filter(
          (s) => s.status === "planning" || s.status === "active"
        );
        setSprints(assignable);
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const prio = priority === "hoch" ? 20 : priority === "niedrig" ? 80 : 50;
      await api(`/api/projects/${projectId}/tickets`, {
        method: "POST",
        body: JSON.stringify({
          title,
          description,
          priority: prio,
          type,
          sprint_id: sprintId || null,
        }),
      });
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h2>Neues Ticket</h2>
          <button className="ghost icon-only" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="field">
          <label>Typ</label>
          <div className="row">
            {(["task", "bug"] as const).map((v) => (
              <label key={v} className="row" style={{ gap: 6 }}>
                <input
                  type="radio"
                  name="tickettype"
                  checked={type === v}
                  onChange={() => setType(v)}
                />
                {v === "task" ? "Task" : "Bug"}
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Titel</label>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="z.B. Login-Form responsiv machen"
          />
        </div>
        <div className="field">
          <label>Beschreibung</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            placeholder="Was soll die KI tun? Akzeptanzkriterien, Hinweise…"
          />
        </div>
        <div className="field">
          <label>Priorität</label>
          <div className="row">
            {(["hoch", "mittel", "niedrig"] as const).map((p) => (
              <label key={p} className="row" style={{ gap: 6 }}>
                <input
                  type="radio"
                  name="prio"
                  checked={priority === p}
                  onChange={() => setPriority(p)}
                />
                {p}
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Sprint (optional — sonst wird Ticket nicht gestartet)</label>
          <select value={sprintId} onChange={(e) => setSprintId(e.target.value)}>
            <option value="">— kein Sprint —</option>
            {sprints.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.status})
              </option>
            ))}
          </select>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {err && <span className="badge err" style={{ marginRight: "auto" }}>{err}</span>}
          <button className="ghost" onClick={onClose}>Abbrechen</button>
          <button className="primary" disabled={!title.trim() || busy} onClick={submit}>
            {busy ? "lege an…" : <><Icon name="check" size={14} /> Anlegen</>}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TicketDetailView({
  projectId,
  ticketNumber,
  version,
  onChanged,
}: {
  projectId: string;
  ticketNumber: number;
  version: number;
  onChanged: () => void;
}) {
  const [t, setT] = useState<TicketWithComments | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [project, setProject] = useState<Project | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const ticketId = t?.id ?? null;

  const refresh = () =>
    api<TicketWithComments>(
      `/api/projects/${projectId}/tickets/by-number/${ticketNumber}`
    )
      .then(setT)
      .catch(console.error);

  useEffect(() => {
    refresh();
  }, [projectId, ticketNumber, version]);

  useEffect(() => {
    api<Sprint[]>(`/api/projects/${projectId}/sprints`)
      .then((all) =>
        setSprints(
          all.filter((s) => s.status === "planning" || s.status === "active")
        )
      )
      .catch(() => {});
    api<{ colors: Record<string, string> }>("/api/setup/status-colors")
      .then((r) => setColors(r.colors))
      .catch(() => {});
    api<Project>(`/api/projects/${projectId}`)
      .then(setProject)
      .catch(() => {});
  }, [projectId, version]);

  const key = project?.key ?? "";

  const setSprint = async (sid: string) => {
    if (!ticketId) return;
    await api(`/api/projects/${projectId}/tickets/${ticketId}`, {
      method: "PATCH",
      body: JSON.stringify({ sprint_id: sid || null }),
    });
    onChanged();
    refresh();
  };

  const setStatus = async (status: TicketStatus) => {
    if (!ticketId) return;
    await api(`/api/projects/${projectId}/tickets/${ticketId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    onChanged();
    refresh();
  };

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [t?.comments.length]);

  const backToList = () => {
    location.hash = `/projects/${projectId}/tickets`;
  };

  if (!t) {
    return <div className="card muted">lade…</div>;
  }

  const st = statusBadge(t.status);

  const send = async () => {
    if (!reply.trim() || !ticketId) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/projects/${projectId}/tickets/${ticketId}/reply`, {
        method: "POST",
        body: JSON.stringify({ text: reply.trim() }),
      });
      setReply("");
      onChanged();
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!ticketId) return;
    if (!confirm(`Ticket "${t.title}" abbrechen?`)) return;
    await api(`/api/projects/${projectId}/tickets/${ticketId}`, {
      method: "DELETE",
    });
    onChanged();
    backToList();
  };

  const markDone = async () => {
    if (!ticketId) return;
    await api(`/api/projects/${projectId}/tickets/${ticketId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "done" }),
    });
    onChanged();
    refresh();
  };

  const reopen = async () => {
    if (!ticketId) return;
    await api(`/api/projects/${projectId}/tickets/${ticketId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "backlog" }),
    });
    onChanged();
    refresh();
  };

  const accept = async () => {
    if (!ticketId) return;
    if (!confirm(`Ticket "${t.title}" abnehmen? Branch wird in Sprint gemerged.`))
      return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/projects/${projectId}/tickets/${ticketId}/accept`, {
        method: "POST",
      });
      onChanged();
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canReply =
    t.status === "in_progress" ||
    t.status === "awaiting_reply" ||
    t.status === "ready_for_testing" ||
    t.status === "backlog";

  const currentSprint = sprints.find((s) => s.id === t.sprint_id);
  const sprintLocked = t.status === "in_progress" || t.status === "awaiting_reply";

  // Primary action depends on status
  const primaryAction = (() => {
    if (t.status === "ready_for_testing") {
      return (
        <button className="primary" onClick={accept} disabled={busy}>
          <Icon name="check" size={13} /> Abnehmen + Merge
        </button>
      );
    }
    if (t.status === "done" || t.status === "cancelled") {
      return (
        <button onClick={reopen} disabled={busy}>
          <Icon name="refresh" size={13} /> Wieder öffnen
        </button>
      );
    }
    if (t.status === "awaiting_reply") {
      return (
        <button onClick={() => setStatus("in_progress")} disabled={busy}>
          <Icon name="play" size={13} /> Wieder aktivieren
        </button>
      );
    }
    if (t.status === "in_progress") {
      return (
        <button onClick={() => setStatus("ready_for_testing")} disabled={busy}>
          <Icon name="check" size={13} /> → Ready for Test
        </button>
      );
    }
    // backlog
    return null;
  })();

  return (
    <div className="card ticket-page">
      <div className="card-head">
        <h2>
          <button
            className="ghost icon-only"
            title="Zurück zur Liste"
            onClick={backToList}
            style={{ marginRight: 6 }}
          >
            <Icon name="arrow-left" size={16} />
          </button>
          <code className={`ticket-id${(t.type ?? "task") === "bug" ? " ticket-id-bug" : ""}`}>
            {key}-{ticketPrefix(t)}{t.number}
          </code>{" "}
          {t.title}
        </h2>
        <div className="row" style={{ gap: 8, flexShrink: 0 }}>
          {primaryAction}
        </div>
      </div>

        <div className="ticket-body">
          {/* --- MAIN COLUMN --- */}
          <div className="ticket-main-col">
            <TicketDescription
              t={t}
              projectId={projectId}
              onSaved={() => {
                onChanged();
                refresh();
              }}
            />


            <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: 13, textTransform: "uppercase", color: "var(--text-subtle)" }}>
              Aktivität
            </h3>
            <div className="ticket-log" ref={logRef}>
              {t.comments.length === 0 && (
                <div className="muted" style={{ fontSize: 12, textAlign: "center", padding: 16 }}>
                  Noch nichts.
                </div>
              )}
              {t.comments.map((c) => (
                <TicketCommentRow key={c.id} c={c} projectId={projectId} />
              ))}
            </div>

            <div className="chat-input" style={{ marginTop: 12 }}>
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder={
                  canReply ? "Antwort / zusätzliche Info…" : "Ticket ist geschlossen"
                }
                disabled={!canReply || busy}
                rows={3}
              />
              <button
                className="primary"
                disabled={!canReply || !reply.trim() || busy}
                onClick={send}
              >
                {busy ? "…" : <><Icon name="send" size={14} /> Senden</>}
              </button>
            </div>

            {(err ||
              t.status === "in_progress" ||
              t.status === "awaiting_reply" ||
              t.status === "backlog" ||
              t.status === "ready_for_testing") && (
              <div className="row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
                {err && (
                  <span className="badge err" style={{ marginRight: "auto" }}>
                    {err}
                  </span>
                )}
                {t.status !== "done" && t.status !== "cancelled" && (
                  <button className="danger" onClick={cancel} disabled={busy}>
                    <Icon name="trash" size={13} /> Abbrechen
                  </button>
                )}
              </div>
            )}
          </div>

          {/* --- SIDE COLUMN (Jira-style details) --- */}
          <div className="ticket-side-col">
            <div className="field">
              <label>Status</label>
              <select
                className={`status-pill ${st.pulse ? "pulse" : ""}`}
                style={statusBadgeStyle(t.status, colors)}
                value={t.status}
                onChange={(e) => setStatus(e.target.value as TicketStatus)}
                disabled={busy}
              >
                {ALL_STATUSES.map((s) => (
                  <option key={s} value={s} style={{ color: "#000" }}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>Priorität</label>
              <select
                className="side-select"
                value={
                  t.priority <= 30 ? "hoch" : t.priority >= 70 ? "niedrig" : "mittel"
                }
                onChange={(e) => {
                  const v = e.target.value;
                  const prio = v === "hoch" ? 20 : v === "niedrig" ? 80 : 50;
                  if (!ticketId) return;
                  api(`/api/projects/${projectId}/tickets/${ticketId}`, {
                    method: "PATCH",
                    body: JSON.stringify({ priority: prio }),
                  }).then(() => {
                    onChanged();
                    refresh();
                  });
                }}
                disabled={busy}
              >
                <option value="hoch">hoch</option>
                <option value="mittel">mittel</option>
                <option value="niedrig">niedrig</option>
              </select>
            </div>

            <div className="field">
              <label>Sprint</label>
              <select
                className="side-select"
                value={t.sprint_id ?? ""}
                onChange={(e) => setSprint(e.target.value)}
                disabled={sprintLocked}
              >
                <option value="">— kein Sprint —</option>
                {sprints.map((s) => (
                  <option key={s.id} value={s.id}>
                    {key}-S{s.number} {s.name}
                  </option>
                ))}
                {t.sprint_id && !currentSprint && (
                  <option value={t.sprint_id}>(Sprint geschlossen)</option>
                )}
              </select>
              {sprintLocked && (
                <div className="hint" style={{ fontSize: 11, marginTop: 4 }}>
                  Sprint während laufender/wartender Tickets nicht änderbar.
                </div>
              )}
            </div>

            {t.branch && (
              <div className="field">
                <label>Branch</label>
                <code style={{ fontSize: 11, wordBreak: "break-all" }}>
                  {t.branch}
                </code>
              </div>
            )}

            <div className="field">
              <label>Angelegt</label>
              <div style={{ fontSize: 12 }}>
                {new Date(t.created_at).toLocaleString()}
              </div>
            </div>

            {t.completed_at && (
              <div className="field">
                <label>Abgeschlossen</label>
                <div style={{ fontSize: 12 }}>
                  {new Date(t.completed_at).toLocaleString()}
                </div>
              </div>
            )}
          </div>
        </div>
    </div>
  );
}

function TicketDescription({
  t,
  projectId,
  onSaved,
}: {
  t: TicketWithComments;
  projectId: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(t.description ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(t.description ?? "");
  }, [t.description, editing]);

  const canEdit =
    t.status === "backlog" ||
    t.status === "in_progress" ||
    t.status === "awaiting_reply";

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const next = draft.trim() ? draft : null;
      await api(`/api/projects/${projectId}/tickets/${t.id}`, {
        method: "PATCH",
        body: JSON.stringify({ description: next }),
      });
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setDraft(t.description ?? "");
    setEditing(false);
    setErr(null);
  };

  const header = (
    <div
      className="row"
      style={{ marginTop: 0, marginBottom: 8, alignItems: "center", gap: 8 }}
    >
      <h3
        style={{
          margin: 0,
          fontSize: 13,
          textTransform: "uppercase",
          color: "var(--text-subtle)",
        }}
      >
        Beschreibung
      </h3>
      {canEdit && !editing && (
        <button
          className="ghost"
          style={{ marginLeft: "auto", fontSize: 12, padding: "2px 8px" }}
          onClick={() => setEditing(true)}
        >
          <Icon name="pencil" size={12} /> Bearbeiten
        </button>
      )}
    </div>
  );

  if (editing) {
    return (
      <div style={{ marginBottom: 16 }}>
        {header}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={6}
          placeholder="Akzeptanzkriterien, Hinweise…"
          autoFocus
          disabled={busy}
          style={{ width: "100%" }}
        />
        {(t.status === "in_progress" || t.status === "awaiting_reply") && (
          <div className="hint" style={{ fontSize: 11, marginTop: 4 }}>
            Hinweis: Änderungen werden der laufenden KI als Notify geschickt.
          </div>
        )}
        <div className="row" style={{ gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
          {err && (
            <span className="badge err" style={{ marginRight: "auto" }}>
              {err}
            </span>
          )}
          <button className="ghost" onClick={cancel} disabled={busy}>
            Abbrechen
          </button>
          <button className="primary" onClick={save} disabled={busy}>
            {busy ? "speichere…" : <><Icon name="check" size={13} /> Speichern</>}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      {header}
      {t.description ? (
        <div className="ticket-desc">{t.description}</div>
      ) : (
        <div className="muted" style={{ fontSize: 12, fontStyle: "italic" }}>
          {canEdit
            ? "Keine Beschreibung — nutze „Bearbeiten“, um eine hinzuzufügen."
            : "Keine Beschreibung."}
        </div>
      )}
    </div>
  );
}

function TicketCommentRow({
  c,
  projectId,
}: {
  c: TicketComment;
  projectId: string;
}) {
  const time = new Date(c.ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const icon =
    c.role === "user" ? (
      <Icon name="user" size={12} />
    ) : c.role === "assistant" ? (
      <Icon name="sparkles" size={12} />
    ) : c.role === "permission" ? (
      <Icon name="lock" size={12} />
    ) : (
      <Icon name="dot" size={12} />
    );
  const label =
    c.role === "user"
      ? "du"
      : c.role === "assistant"
        ? "claude"
        : c.role === "permission"
          ? "permission"
          : "system";

  return (
    <div className={`tc-row tc-${c.role}`}>
      <div className="tc-head">
        {icon}
        <span className="tc-label">{label}</span>
        {c.origin && c.origin !== "ui" && c.origin !== "scheduler" && (
          <span className={`origin-tag ${c.origin}`}>{c.origin}</span>
        )}
        <span className="tc-time">{time}</span>
      </div>
      <div className="tc-body">{renderMessageContent(c.text, projectId)}</div>
    </div>
  );
}
