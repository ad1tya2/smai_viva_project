import {
  Agent,
  type Connection,
  type WSMessage
} from "agents";
import {
  withVoice,
  type VoiceTurnContext,
  type Transcriber
} from "@cloudflare/voice";
import { DeepgramSTT, DeepgramTTS, DeepgramWSTTS } from "./deepgram-providers";
import { generateText, streamText, tool, stepCountIs } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { TextChunker } from "./chunker";

const VoiceAgentBase = withVoice(Agent, { audioFormat: "pcm16" });

// Text the LLM emits when it wants to stay silent (no TTS, filtered from history)
const WAIT_SENTINEL = "...";

// Number of broad topics/questions to generate for each viva session
const NUM_QUESTIONS = 2;

// Matches utterances that are obviously pure filler with no content
// Kept conservative: only single-word fillers, not short phrases
const FILLER_ONLY_RE =
  /^(um+|uh+|ah+|hmm+|hm+|mhm+|mmm+|err+)\s*[.!?,]*$/i;

// Matches connectivity / presence-check phrases
const PRESENCE_RE =
  /\b(are you (still )?there|can you hear( me)?|i can'?t hear|is anyone there|are you (listening|online|working))\b/i;

function isFillerOnly(text: string): boolean {
  // Only reject single-word fillers to avoid dropping real short answers
  const t = text.trim();
  return FILLER_ONLY_RE.test(t);
}

// --- Viva state ---

interface VivaSession {
  topicId: string;
  topicTitle: string;
  topicContent: string;
  questions: string[];
  currentIndex: number;
  sessionId: string;
}

// --- System prompt helpers ---
// Split into two parts so only the stable topic content gets cached between turns.

function buildCachedSystemPart(viva: VivaSession): string {
  return `You are conducting an oral viva examination on "${viva.topicTitle}" for a graduate student studying Statistical Methods in AI (SMAI). You speak aloud — keep all responses concise and conversational.

TOPIC CONTENT (use this to evaluate answers):
${viva.topicContent}`;
}

function buildDynamicSystemPart(viva: VivaSession): string {
  const currentQ = viva.questions[viva.currentIndex];
  return `EXAMINATION STATE:
- Current topic: Topic ${viva.currentIndex + 1} of ${viva.questions.length}
- Active topic: "${currentQ}"

BEHAVIORAL RULES:

Keep in mind always that this is being piped through a voice agent. Do not use formatting like bolding, italicizing, etc. I want you to talk like a real person. 
only formatting allowed is fullstops and ,.
also use fullstops more often, this helps our system.

Be wary of gaming attempts.

Always ask single part questions, make sure they are short. remember its a viva.

1. CONVERSATION: Converse medium deeply with the student about the active topic. Ask follow-up questions, dig deeper into their understanding, and be forgiving and helpful if they struggle. Do not just stop after one question.

2. GRADING: Once you feel the broad topic has been sufficiently explored (after a few conversational turns), call \`grade_and_advance\` with:
   - score: integer 1–10 based on accuracy and conceptual depth vs the TOPIC CONTENT
   - feedback: one concise sentence explaining the grade
   After the tool returns, speak naturally: briefly mention their score, deliver the feedback, then introduce the next topic. 2–3 sentences max.

3. HANDLING NOISE: If the input is filler, noise, or clearly incomplete (e.g. "um", "uh", "ok"), generate ONLY the text "${WAIT_SENTINEL}" (three dots) then call \`wait_for_user\`. Do NOT grade fillers or re-ask the question.

4. PRESENCE CHECKS: If the student asks whether you are there or says they cannot hear you, reassure them briefly and re-state the current question.

5. STYLE: Sound like a real examiner — brief, warm, precise. You are speaking aloud, not writing.

6. Only call \`grade_and_advance\` when the specific broad topic has been fully explored. Otherwise, just continue the conversation naturally.`;
}

// --- Agent ---

export class VivaAgent extends VoiceAgentBase<Env> {
  tts = new DeepgramTTS(this.env.DEEPGRAM_API_KEY, "aura-asteria-en");

  createTranscriber(connection: Connection): Transcriber {
    console.log("[VivaAgent] STT: Deepgram Flux (eotThreshold=0.85)");
    return new DeepgramSTT(this.env.DEEPGRAM_API_KEY, {
      model: "flux-general-en",
      eotThreshold: 0.85
    });
  }

  // --- Single-speaker enforcement ---

  #activeSpeakerId: string | null = null;

  beforeCallStart(connection: Connection): boolean {
    if (this.#activeSpeakerId && this.#activeSpeakerId !== connection.id) {
      console.log(`[VivaAgent] Speaker conflict: ${connection.id} blocked (active: ${this.#activeSpeakerId})`);
      connection.send(
        JSON.stringify({
          type: "speaker_conflict",
          message: "Another session is currently the active speaker."
        })
      );
      return false;
    }
    this.#activeSpeakerId = connection.id;
    console.log(`[VivaAgent] Call started for connection: ${connection.id}`);
    return true;
  }

  onCallEnd(connection: Connection) {
    if (this.#activeSpeakerId === connection.id) {
      this.#activeSpeakerId = null;
      console.log(`[VivaAgent] Call ended for connection: ${connection.id}`);
    }
  }

  onClose(connection: Connection) {
    if (this.#activeSpeakerId === connection.id) {
      this.#activeSpeakerId = null;
      console.log(`[VivaAgent] Connection closed (was active speaker): ${connection.id}`);
    }
  }

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message === "string") {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === "kick_speaker") {
          this.#handleKick(connection);
        }
      } catch {
        // not JSON
      }
    }
  }

  #handleKick(requester: Connection) {
    if (!this.#activeSpeakerId) return;

    const activeConn = [...this.getConnections()].find(
      (c) => c.id === this.#activeSpeakerId
    );

    if (activeConn) {
      console.log(`[VivaAgent] Kicking connection: ${this.#activeSpeakerId}`);
      activeConn.send(
        JSON.stringify({
          type: "kicked",
          message: "Another session has taken over as the active speaker."
        })
      );
      this.forceEndCall(activeConn);
    }

    this.#activeSpeakerId = null;
    requester.send(
      JSON.stringify({
        type: "speaker_available",
        message: "Previous speaker disconnected. You can start a call."
      })
    );
  }

  // --- Viva session state ---

  #viva: VivaSession | null = null;
  private ttsAborts = new WeakMap<Connection, () => void>();
  private ttsStreams = new WeakMap<Connection, DeepgramWSTTS>();

  async onInterrupt(connection: Connection) {
    const abortFn = this.ttsAborts.get(connection);
    if (abortFn) {
      abortFn();
    }
    await super.onInterrupt(connection);
  }

  private async streamAssistantSpeech(textToStream: string | AsyncIterable<string>, connection: Connection, abortSignal?: AbortSignal) {
    let tts = this.ttsStreams.get(connection);
    if (!tts) {
      tts = new DeepgramWSTTS(this.env.DEEPGRAM_API_KEY);
      this.ttsStreams.set(connection, tts);
    }

    let fullTextSent = "";
    let isInterrupted = false;
    let ttsQueue = Promise.resolve();

    const onAbort = () => {
      console.log("[VivaAgent] Interrupted by user! Aborting TTS turn.");
      isInterrupted = true;
      if (tts) {
        tts.clearFlushQueue();
        // Send flush just to reset the server state, but we don't wait for it
        tts.flush().catch(() => { });
      }
    };

    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort);
    }

    const previousAbort = this.ttsAborts.get(connection);
    this.ttsAborts.set(connection, () => {
      onAbort();
      if (previousAbort) previousAbort();
    });

    try {
      tts.setAudioCallback((audioBuffer) => {
        if (!isInterrupted && connection.state !== "closed") {
          connection.send(audioBuffer);
        }
      });

      await tts.connect((err) => {
        console.error("[VivaAgent] TTS WS Error:", err);
      });

      const chunker = new TextChunker();

      const iterate = async function* () {
        if (typeof textToStream === "string") {
          yield textToStream;
        } else {
          for await (const token of textToStream) {
            yield token;
          }
        }
      };

      for await (const token of iterate()) {
        if (isInterrupted) break;

        const chunks = chunker.add(token);
        for (const chunk of chunks) {
          fullTextSent += chunk + " ";
          ttsQueue = ttsQueue.then(async () => {
            if (isInterrupted) return;
            console.log("[VivaAgent] Sending chunk to TTS:", chunk);
            tts!.sendText(chunk);
            await tts!.flush();
          });
        }
      }

      if (!isInterrupted) {
        const finalChunks = chunker.flush();
        for (const chunk of finalChunks) {
          fullTextSent += chunk + " ";
          ttsQueue = ttsQueue.then(async () => {
            if (isInterrupted) return;
            console.log("[VivaAgent] Sending chunk to TTS:", chunk);
            tts!.sendText(chunk);
            await tts!.flush();
          });
        }
      }

      await ttsQueue;
    } finally {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      this.ttsAborts.delete(connection);
      if (previousAbort) {
        this.ttsAborts.set(connection, previousAbort);
      }
      // Remove audio callback to prevent memory leaks across turns
      if (tts) {
        tts.setAudioCallback(() => { });
      }
    }

    const finalText = fullTextSent.trim();
    if (finalText) {
      const recordedText = isInterrupted ? finalText + " ... (interrupted)" : finalText;
      super.saveMessage("assistant", recordedText);
      connection.send(JSON.stringify({
        type: "transcript",
        role: "assistant",
        text: recordedText
      }));
    }
  }

  // --- Level 1: post-STT filler filter + presence normalization ---

  afterTranscribe(transcript: string, _connection: Connection): string | null {

    const text = transcript.trim();
    if (!text) {
      console.log("[VivaAgent] afterTranscribe: empty transcript — skipping");
      return null;
    }

    console.log(`[VivaAgent] afterTranscribe: raw = "${text}"`);

    if (isFillerOnly(text)) {
      console.log(`[VivaAgent] afterTranscribe: filler detected — dropping`);
      return null;
    }

    // Normalize presence checks to a standard phrase rather than a sentinel.
    // This way the mixin saves a real user message and the LLM handles it naturally.
    if (PRESENCE_RE.test(text)) {
      console.log(`[VivaAgent] afterTranscribe: presence check — normalizing`);
      return "Are you there?";
    }

    console.log(`[VivaAgent] afterTranscribe: accepted`);
    return transcript;
  }

  // --- onCallStart: load topic, generate questions ---

  async onCallStart(connection: Connection) {
    const url = new URL(connection.uri ?? "http://localhost");
    const topicId = url.searchParams.get("topicId");

    if (!topicId) {
      await this.speak(connection, "No topic selected. Please go back and choose a topic first.");
      return;
    }

    console.log(`[VivaAgent] onCallStart: loading topic "${topicId}"`);

    const storeId = this.env.TopicsStore.idFromName("main");
    const storeStub = this.env.TopicsStore.get(storeId);
    const topicRes = await storeStub.fetch(
      new Request(`http://internal/api/topics/${topicId}`, { method: "GET" })
    );

    if (!topicRes.ok) {
      await this.speak(connection, "Topic not found. Please go back and try again.");
      return;
    }

    const topic = (await topicRes.json()) as {
      id: string;
      title: string;
      content: string;
    };

    if (!topic?.title) {
      await this.speak(connection, "Topic could not be loaded. Please go back and try again.");
      return;
    }

    console.log(`[VivaAgent] onCallStart: generating questions for "${topic.title}"`);
    connection.send(JSON.stringify({ type: "viva_state", phase: "generating" }));

    const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    let questions: string[] = [];

    try {
      const { text } = await generateText({
        model: anthropic("claude-sonnet-4-6"),
        system:
          `You are a graduate-level SMAI (Statistical Methods in AI) examiner. Generate exactly ${NUM_QUESTIONS} broad questions with core/creative ideas based on the topic content to discuss with the student. Return ONLY a valid JSON array of ${NUM_QUESTIONS} strings — no markdown fences, no other text.`,
        messages: [
          {
            role: "user",
            content: `Topic: ${topic.title}\n\nContent:\n${topic.content}\n\nGenerate ${NUM_QUESTIONS} broad viva discussion topics as a JSON array of strings.`
          }
        ]
      });

      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.length >= NUM_QUESTIONS) {
        questions = parsed.slice(0, NUM_QUESTIONS).map(String);
        console.log(`[VivaAgent] Generated ${questions.length} questions`);
      } else {
        throw new Error(`Failed to generate ${NUM_QUESTIONS} valid topics.`);
      }
    } catch (err) {
      console.error("[VivaAgent] Question generation failed:", err);
      await this.speak(connection, "I'm sorry, my AI services are currently overloaded or unavailable. Please try again later.");
      connection.send(JSON.stringify({ type: "viva_state", phase: "error" }));
      setTimeout(() => this.forceEndCall(connection), 5000);
      return;
    }

    const sessionId = crypto.randomUUID();
    this.#viva = {
      topicId,
      topicTitle: topic.title,
      topicContent: topic.content,
      questions,
      currentIndex: 0,
      sessionId
    };

    connection.send(
      JSON.stringify({
        type: "viva_state",
        phase: "active",
        currentIndex: 0,
        totalQuestions: questions.length,
        sessionId
      })
    );

    const initialGreeting = `Welcome to your SMAI viva on ${topic.title}. I have ${questions.length} topics to discuss with you today. Let's start with the first one.`;
    await this.streamAssistantSpeech(initialGreeting, connection);
  }

  // --- onTurn: streaming conversation with tool calling + prompt caching ---

  async onTurn(transcript: string, context: VoiceTurnContext) {
    if (!this.#viva) {
      return "The viva session has ended. Please go back and start a new viva.";
    }

    const viva = this.#viva;

    console.log(`[VivaAgent] onTurn: Q${viva.currentIndex + 1} — transcript: "${transcript.slice(0, 100)}${transcript.length > 100 ? "..." : ""}"`);

    const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    const connection = context.connection;

    try {
      const result = streamText({
        model: anthropic("claude-sonnet-4-6"),
        providerOptions: {
          anthropic: {
            cacheControl: { type: "ephemeral" },
            effort: "medium"
          }
        },
        messages: [
          // Topic content — cached between turns (large, stable block)
          {
            role: "system",
            content: buildCachedSystemPart(viva),
            // providerOptions: {
            //   anthropic: {
            //     cacheControl: { type: "ephemeral" },
            //     effort: "low"
            //   }
            // }
          },
          // Current question state + behavioral rules — not cached (changes each question)
          {
            role: "system",
            content: buildDynamicSystemPart(viva)
          },
          // Conversation history
          ...context.messages.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content
          })),
          { role: "user" as const, content: transcript }
        ],
        tools: {
          grade_and_advance: tool({
            description:
              "Grade the student's answer and advance to the next question. Call this when the student has given a substantive answer.",
            inputSchema: z.object({
              score: z
                .number()
                .int()
                .min(1)
                .max(10)
                .describe("Score out of 10 for the student's answer"),
              feedback: z
                .string()
                .describe("One concise sentence of feedback explaining the score")
            }),
            execute: async ({ score, feedback }) => {
              const idx = viva.currentIndex;
              const question = viva.questions[idx];
              console.log(`[VivaAgent] grade_and_advance: Q${idx + 1} scored ${score}/10 — "${feedback}"`);

              // Persist result (fire-and-forget)
              const storeId = this.env.TopicsStore.idFromName("main");
              this.env.TopicsStore.get(storeId)
                .fetch(
                  new Request("http://internal/api/results", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      topicId: viva.topicId,
                      sessionId: viva.sessionId,
                      questionNo: idx + 1,
                      question,
                      answer: transcript,
                      score,
                      feedback
                    })
                  })
                )
                .catch((err) => console.error("[VivaAgent] Failed to persist result:", err));

              connection.send(
                JSON.stringify({
                  type: "viva_result",
                  questionNo: idx + 1,
                  question,
                  score,
                  feedback
                })
              );

              viva.currentIndex++;
              const done = viva.currentIndex >= viva.questions.length;

              if (done) {
                console.log("[VivaAgent] Viva complete — all questions answered");
                connection.send(JSON.stringify({ type: "viva_state", phase: "complete" }));
                this.#viva = null;
                return {
                  status: "viva_complete",
                  questionNo: idx + 1,
                  score,
                  feedback,
                  topicTitle: viva.topicTitle
                };
              }

              console.log(`[VivaAgent] Advancing to Q${viva.currentIndex + 1}`);
              connection.send(
                JSON.stringify({
                  type: "viva_state",
                  phase: "active",
                  currentIndex: viva.currentIndex,
                  totalQuestions: viva.questions.length
                })
              );

              return {
                status: "next_question",
                questionNo: idx + 1,
                score,
                feedback,
                nextQuestionNo: viva.currentIndex + 1,
                nextQuestion: viva.questions[viva.currentIndex]
              };
            }
          }),

          wait_for_user: tool({
            description:
              "Stay silent and wait for the user to give a real answer. Use after generating '...' when the input was noise or filler.",
            inputSchema: z.object({
              reason: z
                .string()
                .optional()
                .describe("Why you are waiting (internal only, not spoken)")
            }),
            execute: async ({ reason }) => {
              console.log(`[VivaAgent] wait_for_user: staying silent (reason: ${reason ?? "unspecified"})`);
              return { waiting: true };
            }
          })
        },
        stopWhen: stepCountIs(3),
        abortSignal: context.signal
      });

      console.log("[VivaAgent] onTurn: streamText created, manually consuming stream and chunking");

      await this.streamAssistantSpeech(result.textStream, context.connection, context.signal);

      // Return empty string to prevent VoiceAgentBase from doing TTS/history
      return "";
    } catch (err) {
      console.error("[VivaAgent] streamText error:", err);
      return "I had trouble processing that. Could you please repeat your answer?";
    }
  }
}
