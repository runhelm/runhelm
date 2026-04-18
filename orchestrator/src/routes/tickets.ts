import type { FastifyInstance } from "fastify";
import {
  addComment,
  cancelTicket,
  createTicket,
  getTicket,
  handleTicketReply,
  listComments,
  listTickets,
  updateTicket,
  type TicketStatus,
} from "../tickets.js";
import { getProject } from "../workers.js";
import { acceptTicket, notifyTicketDescriptionChanged } from "../scheduler.js";

export default async function ticketRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/tickets",
    async (req, reply) => {
      const p = getProject(req.params.id);
      if (!p) return reply.code(404).send({ error: "project not found" });
      return listTickets(p.id);
    }
  );

  app.post<{
    Params: { id: string };
    Body: {
      title: string;
      description?: string;
      priority?: number;
      sprint_id?: string | null;
      type?: "task" | "bug";
    };
  }>("/api/projects/:id/tickets", async (req, reply) => {
    const p = getProject(req.params.id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const { title, description, priority, sprint_id, type } = req.body ?? ({} as any);
    if (!title || !title.trim())
      return reply.code(400).send({ error: "title required" });
    const ticketType = type === "bug" ? "bug" : "task";
    const t = await createTicket({
      projectId: p.id,
      title: title.trim(),
      description: description?.trim() || undefined,
      priority: typeof priority === "number" ? priority : 50,
      type: ticketType,
    });
    if (sprint_id) {
      updateTicket(t.id, { sprint_id });
    }
    return t;
  });

  app.get<{ Params: { id: string; tid: string } }>(
    "/api/projects/:id/tickets/:tid",
    async (req, reply) => {
      const t = getTicket(req.params.tid);
      if (!t || t.project_id !== req.params.id)
        return reply.code(404).send({ error: "ticket not found" });
      return { ...t, comments: listComments(t.id) };
    }
  );

  app.get<{ Params: { id: string; n: string } }>(
    "/api/projects/:id/tickets/by-number/:n",
    async (req, reply) => {
      const n = Number(req.params.n);
      if (!Number.isFinite(n))
        return reply.code(400).send({ error: "invalid number" });
      const all = listTickets(req.params.id);
      const t = all.find((x) => x.number === n);
      if (!t) return reply.code(404).send({ error: "ticket not found" });
      return { ...t, comments: listComments(t.id) };
    }
  );

  app.patch<{
    Params: { id: string; tid: string };
    Body: {
      title?: string;
      description?: string | null;
      priority?: number;
      status?: TicketStatus;
      sprint_id?: string | null;
    };
  }>("/api/projects/:id/tickets/:tid", async (req, reply) => {
    const t = getTicket(req.params.tid);
    if (!t || t.project_id !== req.params.id)
      return reply.code(404).send({ error: "ticket not found" });
    const body = req.body ?? {};
    const descInBody = Object.prototype.hasOwnProperty.call(body, "description");
    const newDesc = descInBody ? (body.description ?? null) : t.description;
    const descChanged = descInBody && newDesc !== t.description;
    if (descChanged && (t.status === "ready_for_testing" || t.status === "done" || t.status === "cancelled")) {
      return reply
        .code(409)
        .send({ error: "Beschreibung kann ab 'ready for test' nicht mehr geändert werden." });
    }
    const updated = updateTicket(t.id, body);
    if (descChanged && updated && (updated.status === "in_progress" || updated.status === "awaiting_reply")) {
      notifyTicketDescriptionChanged(updated.id).catch((err) =>
        req.log.error({ err }, "description notify failed")
      );
    }
    return updated;
  });

  app.post<{ Params: { id: string; tid: string } }>(
    "/api/projects/:id/tickets/:tid/accept",
    async (req, reply) => {
      const t = getTicket(req.params.tid);
      if (!t || t.project_id !== req.params.id)
        return reply.code(404).send({ error: "ticket not found" });
      try {
        await acceptTicket(t.id);
        return { ok: true };
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
  );

  app.delete<{ Params: { id: string; tid: string } }>(
    "/api/projects/:id/tickets/:tid",
    async (req, reply) => {
      const t = getTicket(req.params.tid);
      if (!t || t.project_id !== req.params.id)
        return reply.code(404).send({ error: "ticket not found" });
      cancelTicket(t.id);
      return { ok: true };
    }
  );

  app.post<{
    Params: { id: string; tid: string };
    Body: { text: string };
  }>("/api/projects/:id/tickets/:tid/reply", async (req, reply) => {
    const t = getTicket(req.params.tid);
    if (!t || t.project_id !== req.params.id)
      return reply.code(404).send({ error: "ticket not found" });
    const text = (req.body?.text ?? "").trim();
    if (!text) return reply.code(400).send({ error: "text required" });
    await handleTicketReply(t.id, text, "ui");
    return { ok: true };
  });

  app.post<{
    Params: { id: string; tid: string };
    Body: { text: string; role?: "system" };
  }>("/api/projects/:id/tickets/:tid/comment", async (req, reply) => {
    const t = getTicket(req.params.tid);
    if (!t || t.project_id !== req.params.id)
      return reply.code(404).send({ error: "ticket not found" });
    const text = (req.body?.text ?? "").trim();
    if (!text) return reply.code(400).send({ error: "text required" });
    await addComment(t.id, req.body?.role ?? "system", text, "ui");
    return { ok: true };
  });
}
