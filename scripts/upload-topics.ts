#!/usr/bin/env node
/**
 * Upload topics JSON to the running app.
 *
 * Usage:
 *   npx tsx scripts/upload-topics.ts topics.json http://localhost:5173
 *   npx tsx scripts/upload-topics.ts topics.json https://smai-viva.workers.dev
 */

import fs from "fs";

async function main() {
  const [topicsFile, baseUrl = "http://localhost:5173"] = process.argv.slice(2);

  if (!topicsFile) {
    process.stderr.write("Usage: npx tsx scripts/upload-topics.ts <topics.json> [<base-url>]\n");
    process.exit(1);
  }

  const topics = JSON.parse(fs.readFileSync(topicsFile, "utf8")) as Array<{
    id: string;
    title: string;
    content: string;
  }>;

  process.stderr.write(`Uploading ${topics.length} topics to ${baseUrl}...\n`);

  for (const topic of topics) {
    const url = `${baseUrl}/api/topics/${topic.id}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: topic.title, content: topic.content })
    });

    if (res.ok) {
      process.stderr.write(`  ✓ ${topic.title}\n`);
    } else {
      process.stderr.write(`  ✗ ${topic.title}: ${res.status} ${res.statusText}\n`);
    }
  }

  process.stderr.write("Done.\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
