#!/usr/bin/env node
/**
 * PDF → Topic JSON Converter
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/process-pdf.ts lecture1.pdf lecture2.pdf > topics.json
 *
 * Then upload to the running app:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/upload-topics.ts topics.json http://localhost:5173
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

async function processPDF(filePath: string): Promise<{ id: string; title: string; content: string }> {
  const pdfBytes = fs.readFileSync(filePath);
  const base64 = pdfBytes.toString("base64");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8192,
    messages: [
      {
        role: "user",
        content: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64
            }
          } as any,
          {
            type: "text",
            text: `Extract and structure the content of this lecture/document for SMAI (Statistical Methods in AI) viva examination preparation.

Return a JSON object with exactly two fields:
- "title": a concise topic title (e.g. "Principal Component Analysis", "K-Means Clustering")
- "content": the full content in markdown format, preserving:
  * Key concepts and definitions
  * Mathematical formulas (use LaTeX notation: $...$ for inline, $$...$$ for block)
  * Algorithms (numbered steps)
  * Important theorems and proofs
  * Examples and intuitions
  * Comparisons with related methods

Return ONLY valid JSON — no markdown code fences, no other text.`
          }
        ]
      }
    ]
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Extract JSON from response (in case model adds any prefix/suffix)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in response for ${path.basename(filePath)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]) as { title: string; content: string };
  if (!parsed.title || !parsed.content) {
    throw new Error(`Invalid JSON shape for ${path.basename(filePath)}`);
  }

  return {
    id: randomUUID(),
    title: parsed.title,
    content: parsed.content
  };
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));

  if (args.length === 0) {
    process.stderr.write(
      "Usage: ANTHROPIC_API_KEY=sk-... npx tsx scripts/process-pdf.ts <file.pdf> [<file2.pdf> ...]\n"
    );
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write("Error: ANTHROPIC_API_KEY environment variable is not set.\n");
    process.exit(1);
  }

  const results: Array<{ id: string; title: string; content: string }> = [];

  for (const filePath of args) {
    if (!fs.existsSync(filePath)) {
      process.stderr.write(`Skipping (not found): ${filePath}\n`);
      continue;
    }

    process.stderr.write(`Processing: ${path.basename(filePath)}...\n`);
    try {
      const result = await processPDF(filePath);
      results.push(result);
      process.stderr.write(`  ✓ Title: ${result.title}\n`);
    } catch (err) {
      process.stderr.write(`  ✗ Error: ${err}\n`);
    }
  }

  // Output JSON to stdout (pipe to a file)
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  process.stderr.write(`\nDone. ${results.length} topic(s) extracted.\n`);
  process.stderr.write(`To upload: npx tsx scripts/upload-topics.ts topics.json <app-url>\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
