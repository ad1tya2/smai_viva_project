import { Agent } from "agents";

export class TopicsStore extends Agent<Env> {
  #ready = false;

  #ensureSchema() {
    if (this.#ready) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS viva_topics (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS viva_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        question_no INTEGER NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        score INTEGER NOT NULL,
        feedback TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;
    this.#ready = true;
  }

  async fetch(request: Request): Promise<Response> {
    this.#ensureSchema();
    const url = new URL(request.url);
    const path = url.pathname;

    // GET /api/topics — list all topics
    if (path === "/api/topics" && request.method === "GET") {
      const rows = this.sql<{ id: string; title: string; content: string }>`
        SELECT id, title, content FROM viva_topics ORDER BY updated_at DESC
      `;
      return Response.json(rows);
    }

    // GET /api/topics/:id — single topic
    if (/^\/api\/topics\/[^/]+$/.test(path) && request.method === "GET") {
      const id = path.split("/")[3];
      const rows = this.sql<{ id: string; title: string; content: string }>`
        SELECT id, title, content FROM viva_topics WHERE id = ${id}
      `;
      if (rows.length === 0) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(rows[0]);
    }

    // PUT /api/topics/:id — upsert topic
    if (/^\/api\/topics\/[^/]+$/.test(path) && request.method === "PUT") {
      const id = path.split("/")[3];
      const { title, content } = await request.json() as { title: string; content: string };
      const now = new Date().toISOString();
      this.sql`
        INSERT INTO viva_topics (id, title, content, updated_at)
        VALUES (${id}, ${title}, ${content}, ${now})
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          updated_at = excluded.updated_at
      `;
      return Response.json({ ok: true });
    }

    // DELETE /api/topics/:id
    if (/^\/api\/topics\/[^/]+$/.test(path) && request.method === "DELETE") {
      const id = path.split("/")[3];
      this.sql`DELETE FROM viva_topics WHERE id = ${id}`;
      this.sql`DELETE FROM viva_results WHERE topic_id = ${id}`;
      return Response.json({ ok: true });
    }

    // GET /api/topics/:id/results — results for a topic
    if (/^\/api\/topics\/[^/]+\/results$/.test(path) && request.method === "GET") {
      const id = path.split("/")[3];
      const rows = this.sql<{
        session_id: string;
        question_no: number;
        question: string;
        answer: string;
        score: number;
        feedback: string;
        created_at: string;
      }>`
        SELECT session_id, question_no, question, answer, score, feedback, created_at
        FROM viva_results
        WHERE topic_id = ${id}
        ORDER BY created_at DESC, question_no ASC
      `;
      return Response.json(rows);
    }

    // POST /api/results — called internally from VivaAgent to persist a graded answer
    if (path === "/api/results" && request.method === "POST") {
      const body = await request.json() as {
        topicId: string;
        sessionId: string;
        questionNo: number;
        question: string;
        answer: string;
        score: number;
        feedback: string;
      };
      const now = new Date().toISOString();
      this.sql`
        INSERT INTO viva_results (topic_id, session_id, question_no, question, answer, score, feedback, created_at)
        VALUES (
          ${body.topicId}, ${body.sessionId}, ${body.questionNo},
          ${body.question}, ${body.answer}, ${body.score},
          ${body.feedback}, ${now}
        )
      `;
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
