import { routeAgentRequest } from "agents";

export { VivaAgent } from "./viva-agent";
export { TopicsStore } from "./topics-store";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Handle PDF/text import separately (needs ANTHROPIC_API_KEY from env)
    if (url.pathname === "/api/import-file" && request.method === "POST") {
      return handleFileImport(request, env);
    }

    // Route all /api/* requests to the singleton TopicsStore DO
    if (url.pathname.startsWith("/api/")) {
      const id = env.TopicsStore.idFromName("main");
      const stub = env.TopicsStore.get(id);
      return stub.fetch(
        new Request(`http://internal${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body: request.body
        })
      );
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

// --- PDF / text file import ---

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

const EXTRACT_PROMPT = `Extract and structure the content of this lecture/document for viva examination preparation.

IMPORTANT: Create at most 1-2 broad topic entries. A typical lecture should produce exactly 1 topic. Only create 2 if the lecture clearly covers two completely unrelated subjects.

Each topic should be comprehensive — fold ALL subtopics, examples, theorems, and details into the single topic's content rather than splitting them out.

Return a JSON array of objects, each with exactly two fields:
- "title": a concise topic title (e.g. "Principal Component Analysis", "Kernel Methods")
- "content": the full content in markdown format, preserving:
  * Key concepts and definitions
  * Mathematical formulas (use LaTeX notation: $...$ for inline, $$...$$ for block)
  * Algorithms (numbered steps)
  * Important theorems and proofs
  * Examples and intuitions
  * Comparisons with related methods

Return ONLY valid JSON — no markdown code fences, no other text.`;

async function handleFileImport(request: Request, env: Env): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return Response.json({ error: "No file provided" }, { status: 400 });
    }

    const fileName = file.name.toLowerCase();
    const isPdf = fileName.endsWith(".pdf");
    const isTxt = fileName.endsWith(".txt") || fileName.endsWith(".md");

    if (!isPdf && !isTxt) {
      return Response.json({ error: "Only .pdf, .txt, and .md files are supported" }, { status: 400 });
    }

    let topics: Array<{ title: string; content: string }>;

    if (isTxt) {
      // For text files: use the filename as title, raw text as content
      const text = await file.text();
      const title = file.name.replace(/\.(txt|md)$/i, "").replace(/[_-]/g, " ");
      topics = [{ title, content: text }];
    } else {
      // For PDFs: send to Anthropic for extraction
      const arrayBuffer = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);

      console.log(`[ImportFile] Processing PDF: ${file.name} (${Math.round(arrayBuffer.byteLength / 1024)}KB)`);

      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          messages: [{
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: base64
                }
              },
              {
                type: "text",
                text: EXTRACT_PROMPT
              }
            ]
          }]
        })
      });

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text();
        console.error("[ImportFile] Anthropic API error:", anthropicRes.status, errText);
        return Response.json({ error: `Anthropic API error: ${anthropicRes.status}` }, { status: 502 });
      }

      const result = await anthropicRes.json() as {
        content: Array<{ type: string; text?: string }>;
      };

      const responseText = result.content.find(c => c.type === "text")?.text ?? "";
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        // Try single object
        const objMatch = responseText.match(/\{[\s\S]*\}/);
        if (objMatch) {
          const parsed = JSON.parse(objMatch[0]) as { title: string; content: string };
          topics = [parsed];
        } else {
          console.error("[ImportFile] No JSON found in response:", responseText.slice(0, 200));
          return Response.json({ error: "Failed to extract content from PDF" }, { status: 500 });
        }
      } else {
        topics = JSON.parse(jsonMatch[0]) as Array<{ title: string; content: string }>;
      }

      // Limit to 2 topics max
      topics = topics.slice(0, 2);
      console.log(`[ImportFile] Extracted ${topics.length} topic(s) from ${file.name}`);
    }

    // Save each topic to TopicsStore
    const storeId = env.TopicsStore.idFromName("main");
    const storeStub = env.TopicsStore.get(storeId);
    const savedTopics: Array<{ id: string; title: string; content: string }> = [];

    for (const topic of topics) {
      const id = crypto.randomUUID();
      await storeStub.fetch(
        new Request(`http://internal/api/topics/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: topic.title, content: topic.content })
        })
      );
      savedTopics.push({ id, title: topic.title, content: topic.content });
    }

    return Response.json({ topics: savedTopics });
  } catch (err) {
    console.error("[ImportFile] Error:", err);
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
