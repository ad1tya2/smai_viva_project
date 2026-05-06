import type { Transcriber, TranscriberSession, TranscriberSessionOptions, TTSProvider } from "@cloudflare/voice";

interface DeepgramSTTOptions {
  model?: string;
  sampleRate?: number;
  eotThreshold?: number;
}

export class DeepgramSTT implements Transcriber {
  constructor(private apiKey: string, private options: DeepgramSTTOptions = {}) { }

  createSession(sessionOptions?: TranscriberSessionOptions): TranscriberSession {
    const session = new DeepgramSTTSession(
      this.apiKey,
      this.options.model ?? "flux-general-en",
      this.options.sampleRate ?? 16000,
      this.options.eotThreshold ?? 0.85,
      sessionOptions
    );
    session.connect();
    return session;
  }
}

class DeepgramSTTSession implements TranscriberSession {
  private socket: WebSocket | null = null;
  private pendingAudio: ArrayBuffer[] = [];

  constructor(
    private apiKey: string,
    private model: string,
    private sampleRate: number,
    private eotThreshold: number,
    private options?: TranscriberSessionOptions
  ) { }

  connect() {
    if (this.socket) return;

    const url = new URL("https://api.deepgram.com/v2/listen");
    url.searchParams.set("model", this.model);
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", String(this.sampleRate));
    url.searchParams.set("eot_threshold", String(this.eotThreshold));

    // Note: Cloudflare Workers native fetch supports the websocket property
    fetch(url, {
      headers: {
        Authorization: `Token ${this.apiKey}`,
        Upgrade: "websocket"
      }
    }).then(response => {
      const socket = response.webSocket;
      if (!socket) {
        console.error("[DeepgramSTT] WebSocket upgrade failed");
        return;
      }

      socket.accept();
      this.socket = socket;

      socket.addEventListener("message", (event) => {
        let payloadText = "";
        if (typeof event.data === "string") {
          payloadText = event.data;
        } else if (event.data instanceof ArrayBuffer) {
          payloadText = new TextDecoder().decode(event.data);
        } else {
          return;
        }

        try {
          const parsed = JSON.parse(payloadText);

          if (parsed.event === "EndOfTurn") {
            const transcript = parsed.transcript?.trim();
            if (transcript && this.options?.onUtterance) {
              this.options.onUtterance(transcript);
            }
          } else if (parsed.type === "Results") {
            // Fallback for non-flux models if ever used
            const transcript = parsed.channel?.alternatives?.[0]?.transcript?.trim();
            if (transcript) {
              if (parsed.is_final || parsed.speech_final) {
                this.options?.onUtterance?.(transcript);
              } else {
                this.options?.onInterim?.(transcript);
              }
            }
          }
        } catch (err) {
          // Ignore JSON parse errors
        }
      });

      socket.addEventListener("close", () => {
        this.socket = null;
      });

      // Flush any pending audio chunks that were buffered before connection
      for (const chunk of this.pendingAudio) {
        this.socket.send(chunk);
      }
      this.pendingAudio = [];
    }).catch(err => {
      console.error("[DeepgramSTT] Connection error:", err);
    });
  }

  feed(chunk: ArrayBuffer) {
    // In Workers, readyState 1 is OPEN
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(chunk);
    } else {
      this.pendingAudio.push(chunk);
    }
  }

  close() {
    try {
      this.socket?.close(1000, "session_closed");
    } catch { }
    this.socket = null;
  }
}

export class DeepgramTTS implements TTSProvider {
  constructor(private apiKey: string, private model = "aura-2-apollo-en") { }

  async synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    try {
      const res = await fetch(`https://api.deepgram.com/v1/speak?model=${this.model}&encoding=linear16&sample_rate=16000`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text }),
        signal
      });

      if (!res.ok) {
        console.error("[DeepgramTTS] API error:", await res.text());
        return null;
      }

      return await res.arrayBuffer();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Expected on interruption
        return null;
      }
      console.error("[DeepgramTTS] Synthesis error:", err);
      return null;
    }
  }
}

export class DeepgramWSTTS {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private url = "https://api.deepgram.com/v1/speak?model=aura-2-apollo-en&encoding=linear16&sample_rate=16000";

  private onAudioCb: ((chunk: ArrayBuffer) => void) | null = null;
  private flushQueue: Array<() => void> = [];

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  // Allow replacing the audio callback per-turn
  setAudioCallback(cb: (chunk: ArrayBuffer) => void) {
    this.onAudioCb = cb;
  }

  async connect(onError: (e: any) => void) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    const response = await fetch(this.url, {
      headers: {
        Authorization: `Token ${this.apiKey}`,
        Upgrade: "websocket",
      },
    });

    const socket = response.webSocket;
    if (!socket) {
      const errText = await response.text().catch(() => "Unknown error");
      console.log("[DeepgramWSTTS] Failed to upgrade to websocket.", response.status, errText);
      throw new Error(`Failed to connect to Deepgram WS: ${response.status} - ${errText}`);
    }

    console.log("[DeepgramWSTTS] Connected using websocket upgrade.");
    this.ws = socket;
    this.ws.accept();

    this.ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === "Flushed") {
            const resolve = this.flushQueue.shift();
            if (resolve) resolve();
          } else if (parsed.type === "Error") {
            onError(new Error(parsed.err_msg || parsed.message || "Unknown Deepgram WS Error"));
          } else {
            console.log("[DeepgramWSTTS] JSON message:", parsed);
          }
        } catch (e) {
          console.error("[DeepgramWSTTS] Error parsing message:", e);
        }
      } else {
        // Binary audio data
        if (this.onAudioCb) {
          this.onAudioCb(event.data as ArrayBuffer);
        }
      }
    });

    this.ws.addEventListener("error", (e) => onError(e));
    this.ws.addEventListener("close", () => {
      console.log("[DeepgramWSTTS] Connection closed.");
      this.ws = null;
      // Resolve any pending flushes
      while (this.flushQueue.length > 0) {
        this.flushQueue.shift()!();
      }
    });
  }

  sendText(text: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "Speak", text }));
    }
  }

  flush(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.flushQueue.push(resolve);
        this.ws.send(JSON.stringify({ type: "Flush" }));
      } else {
        resolve();
      }
    });
  }

  clearFlushQueue() {
    this.flushQueue = [];
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch (e) { }
    }
    this.ws = null;
  }
}
