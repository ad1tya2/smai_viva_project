import { useVoiceAgent, type VoiceStatus } from "@cloudflare/voice/react";
import {
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneDisconnectIcon,
  WaveformIcon,
  SpinnerGapIcon,
  SpeakerHighIcon,
  CaretDownIcon,
  CaretRightIcon,
  PlusIcon,
  TrashIcon,
  FloppyDiskIcon,
  ChalkboardTeacherIcon,
  MoonIcon,
  SunIcon,
  ArrowLeftIcon,
  CheckCircleIcon,
  ClockIcon,
  UploadSimpleIcon,
  FileTextIcon
} from "@phosphor-icons/react";
import { Button, Input, Surface, Text } from "@cloudflare/kumo";
import { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// --- Types ---

interface Topic {
  id: string;
  title: string;
  content: string;
}

interface VivaResultRow {
  session_id: string;
  question_no: number;
  question: string;
  answer: string;
  score: number;
  feedback: string;
  created_at: string;
}

interface VivaSession {
  session_id: string;
  date: string;
  results: VivaResultRow[];
  avg: number;
}

type VivaPhase = "idle" | "generating" | "active" | "complete";

// --- Session ID (per browser tab) ---

function getSessionId(): string {
  const KEY = "viva-session-id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

// --- Helpers ---

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(isoStr: string): string {
  return new Date(isoStr).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function scoreColor(score: number): string {
  if (score >= 8) return "text-green-600 dark:text-green-400";
  if (score >= 5) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function groupBySessions(rows: VivaResultRow[]): VivaSession[] {
  const map = new Map<string, VivaResultRow[]>();
  for (const row of rows) {
    const list = map.get(row.session_id) ?? [];
    list.push(row);
    map.set(row.session_id, list);
  }
  return Array.from(map.entries()).map(([session_id, results]) => {
    const sorted = [...results].sort((a, b) => a.question_no - b.question_no);
    const avg = sorted.reduce((s, r) => s + r.score, 0) / sorted.length;
    return { session_id, date: sorted[0].created_at, results: sorted, avg: Math.round(avg * 10) / 10 };
  });
}

// --- Theme toggle ---

function ModeToggle() {
  const [mode, setMode] = useState(() => localStorage.getItem("theme") || "light");

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

// --- TopicCard ---

function TopicCard({
  topic,
  onStartViva,
  onDelete
}: {
  topic: Topic;
  onStartViva: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editTitle, setEditTitle] = useState(topic.title);
  const [editContent, setEditContent] = useState(topic.content);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [results, setResults] = useState<VivaSession[] | null>(null);
  const [loadingResults, setLoadingResults] = useState(false);

  // Load results when expanded
  useEffect(() => {
    if (!expanded || results !== null) return;
    setLoadingResults(true);
    fetch(`/api/topics/${topic.id}/results`)
      .then((r) => r.json())
      .then((rows) => {
        setResults(groupBySessions(rows as VivaResultRow[]));
      })
      .catch(() => setResults([]))
      .finally(() => setLoadingResults(false));
  }, [expanded, topic.id, results]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch(`/api/topics/${topic.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: editTitle, content: editContent })
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete topic "${editTitle}"?`)) return;
    await fetch(`/api/topics/${topic.id}`, { method: "DELETE" });
    onDelete(topic.id);
  };

  const handleStartViva = async () => {
    // Ensure topic is saved first
    await fetch(`/api/topics/${topic.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: editTitle, content: editContent })
    });
    onStartViva(topic.id);
  };

  return (
    <Surface className="rounded-xl ring ring-kumo-line overflow-hidden">
      {/* Header row */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-kumo-fill/50 transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? (
          <CaretDownIcon size={16} className="text-kumo-secondary flex-shrink-0" />
        ) : (
          <CaretRightIcon size={16} className="text-kumo-secondary flex-shrink-0" />
        )}
        <span className="font-medium flex-1 truncate">{editTitle || "Untitled Topic"}</span>
        {!expanded && (
          <Button
            variant="primary"
            size="sm"
            icon={<ChalkboardTeacherIcon size={14} weight="fill" />}
            onClick={(e) => { e.stopPropagation(); handleStartViva(); }}
          >
            Start Viva
          </Button>
        )}
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-kumo-line space-y-4 pt-4">
          {/* Box 1: Title */}
          <div>
            <label className="block text-xs font-medium text-kumo-secondary mb-1">Topic Title</label>
            <Input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="Enter topic title..."
              className="w-full"
            />
          </div>

          {/* Box 2: Content */}
          <div>
            <label className="block text-xs font-medium text-kumo-secondary mb-1">
              Content <span className="font-normal">(markdown)</span>
            </label>
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              placeholder="Paste or type topic content in markdown..."
              rows={12}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono bg-kumo-fill border border-kumo-line focus:outline-none focus:ring-2 focus:ring-kumo-brand/40 resize-y text-kumo-default placeholder:text-kumo-secondary"
            />
          </div>

          {/* Box 3: Actions */}
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              variant="primary"
              icon={<ChalkboardTeacherIcon size={16} weight="fill" />}
              onClick={handleStartViva}
              disabled={!editTitle.trim()}
            >
              Start Viva
            </Button>
            <Button
              variant="secondary"
              icon={saving ? <SpinnerGapIcon size={16} className="animate-spin" /> : <FloppyDiskIcon size={16} />}
              onClick={handleSave}
              disabled={saving}
            >
              {saved ? "Saved!" : saving ? "Saving..." : "Save"}
            </Button>
            <Button
              variant="ghost"
              icon={<TrashIcon size={16} />}
              onClick={handleDelete}
              className="ml-auto text-red-500 hover:text-red-600"
            >
              Delete
            </Button>
          </div>

          {/* Past viva results */}
          <div>
            <h3 className="text-xs font-semibold text-kumo-secondary uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <ClockIcon size={12} />
              Past Viva Results
            </h3>
            {loadingResults ? (
              <div className="text-sm text-kumo-secondary flex items-center gap-2">
                <SpinnerGapIcon size={14} className="animate-spin" />
                Loading results...
              </div>
            ) : results && results.length > 0 ? (
              <div className="space-y-3">
                {results.map((session) => (
                  <SessionResult key={session.session_id} session={session} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-kumo-secondary italic">No viva results yet.</p>
            )}
          </div>
        </div>
      )}
    </Surface>
  );
}

function SessionResult({ session }: { session: VivaSession }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-kumo-line overflow-hidden">
      <div
        className="flex items-center gap-3 px-3 py-2 bg-kumo-fill/50 cursor-pointer hover:bg-kumo-fill transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <CaretDownIcon size={12} className="text-kumo-secondary" /> : <CaretRightIcon size={12} className="text-kumo-secondary" />}
        <span className="text-xs text-kumo-secondary flex-1">{formatDate(session.date)}</span>
        <span className={`text-sm font-semibold tabular-nums ${scoreColor(session.avg)}`}>
          Avg: {session.avg}/10
        </span>
      </div>
      {open && (
        <div className="divide-y divide-kumo-line">
          {session.results.map((r) => (
            <div key={r.question_no} className="px-3 py-2 text-xs">
              <div className="flex items-start gap-2">
                <span className="font-semibold text-kumo-secondary flex-shrink-0 w-5">Q{r.question_no}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-kumo-default font-medium truncate">{r.question}</p>
                  <p className="text-kumo-secondary mt-0.5 line-clamp-2">{r.answer}</p>
                  <p className="text-kumo-secondary mt-1 italic">{r.feedback}</p>
                </div>
                <span className={`font-bold tabular-nums flex-shrink-0 ${scoreColor(r.score)}`}>
                  {r.score}/10
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- FileDropZone ---

function FileDropZone({ onImported }: { onImported: (topics: Topic[]) => void }) {
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = async (file: File) => {
    setImporting(true);
    setError(null);
    setImportStatus(`Processing ${file.name}...`);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/import-file", { method: "POST", body: formData });
      const data = await res.json() as { topics?: Topic[]; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? "Import failed");
      } else if (data.topics) {
        setImportStatus(`✓ Added ${data.topics.length} topic${data.topics.length === 1 ? "" : "s"}: ${data.topics.map(t => t.title).join(", ")}`);
        onImported(data.topics);
      }
    } catch (err) {
      setError(`Upload failed: ${err}`);
    } finally {
      setImporting(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = "";
  };

  return (
    <div
      className={`relative border-2 border-dashed rounded-xl p-6 text-center transition-all duration-200 cursor-pointer ${dragging
        ? "border-kumo-brand bg-kumo-brand/5 scale-[1.01]"
        : "border-kumo-line hover:border-kumo-brand/50 hover:bg-kumo-fill/40"
        }`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => !importing && fileInputRef.current?.click()}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.txt,.md"
        className="hidden"
        onChange={handleFileInput}
      />
      <div className="flex flex-col items-center gap-2 pointer-events-none">
        {importing ? (
          <>
            <SpinnerGapIcon size={28} className="animate-spin text-kumo-brand" />
            <p className="text-sm text-kumo-secondary">{importStatus}</p>
          </>
        ) : (
          <>
            <UploadSimpleIcon size={28} className={`${dragging ? "text-kumo-brand" : "text-kumo-secondary"} transition-colors`} />
            <div>
              <p className="text-sm font-medium">Drop a lecture PDF here</p>
              <p className="text-xs text-kumo-secondary mt-0.5">or click to browse · PDF, TXT, MD</p>
            </div>
            {importStatus && !error && (
              <p className="text-xs text-green-600 dark:text-green-400 mt-1">{importStatus}</p>
            )}
          </>
        )}
        {error && (
          <p className="text-xs text-red-500 mt-1">{error}</p>
        )}
      </div>
    </div>
  );
}

// --- TopicListPage ---

function TopicListPage({ onStartViva }: { onStartViva: (topicId: string) => void }) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/topics")
      .then((r) => r.json())
      .then((data) => setTopics(data as Topic[]))
      .catch(() => setTopics([]))
      .finally(() => setLoading(false));
  }, []);

  const handleAdd = async () => {
    const id = crypto.randomUUID();
    const newTopic: Topic = { id, title: "New Topic", content: "" };
    await fetch(`/api/topics/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTopic.title, content: newTopic.content })
    });
    setTopics((prev) => [newTopic, ...prev]);
  };

  const handleDelete = (id: string) => {
    setTopics((prev) => prev.filter((t) => t.id !== id));
  };

  const handleImported = (newTopics: Topic[]) => {
    setTopics((prev) => [...newTopics, ...prev]);
  };

  return (
    <div className="min-h-full p-6">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <ChalkboardTeacherIcon size={32} weight="duotone" className="text-kumo-brand" />
            <div>
              <Text variant="heading1" as="h1">SMAI Viva Prep</Text>
              <p className="text-sm text-kumo-secondary mt-0.5">Select a topic to begin your examination</p>
            </div>
          </div>
          <ModeToggle />
        </div>

        {/* Drop zone */}
        <div className="mb-5">
          <FileDropZone onImported={handleImported} />
        </div>

        {/* Add topic button */}
        <div className="mb-4">
          <Button
            variant="secondary"
            size="sm"
            icon={<PlusIcon size={14} weight="bold" />}
            onClick={handleAdd}
          >
            Add blank topic
          </Button>
        </div>

        {/* Topic list */}
        {loading ? (
          <div className="flex items-center justify-center py-16 text-kumo-secondary gap-2">
            <SpinnerGapIcon size={20} className="animate-spin" />
            <span>Loading topics...</span>
          </div>
        ) : topics.length === 0 ? (
          <div className="text-center py-16 text-kumo-secondary">
            <FileTextIcon size={48} weight="duotone" className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">No topics yet. Drop a PDF above or add one manually.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {topics.map((topic) => (
              <TopicCard
                key={topic.id}
                topic={topic}
                onStartViva={onStartViva}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Status display helper ---

function getStatusDisplay(status: VoiceStatus) {
  switch (status) {
    case "idle":
      return { text: "Ready", icon: ChalkboardTeacherIcon, color: "text-kumo-secondary" };
    case "listening":
      return { text: "Listening...", icon: WaveformIcon, color: "text-green-600 dark:text-green-400" };
    case "thinking":
      return { text: "Thinking...", icon: SpinnerGapIcon, color: "text-amber-600 dark:text-amber-400" };
    case "speaking":
      return { text: "Speaking...", icon: SpeakerHighIcon, color: "text-blue-600 dark:text-blue-400" };
  }
}

// --- VivaPage ---

interface LiveResult {
  questionNo: number;
  question: string;
  score: number;
  feedback: string;
}

function VivaPage({
  topicId,
  onExit
}: {
  topicId: string;
  onExit: () => void;
}) {
  const sessionId = useRef(getSessionId()).current;

  const {
    status,
    transcript,
    connected,
    startCall,
    endCall,
    audioLevel,
    isMuted,
    toggleMute,
    lastCustomMessage,
    error
  } = useVoiceAgent({
    agent: "viva-agent",
    name: sessionId,
    query: { topicId }
  });

  const [phase, setPhase] = useState<VivaPhase>("idle");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [liveResults, setLiveResults] = useState<LiveResult[]>([]);
  const [topicTitle, setTopicTitle] = useState<string>("");

  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  // Create MicVAD once when connected — do NOT re-create on status change,
  // as that causes a new VAD to fire a spurious initial speech event.
  useEffect(() => {
    if (!connected) return;

    let myVad: any;
    if ((window as any).vad?.MicVAD) {
      (window as any).vad.MicVAD.new({
        model: "v5",
        startOnLoad: true,
        baseAssetPath: "/vendor/vad/",
        onnxWASMBasePath: "/vendor/ort/",
        positiveSpeechThreshold: 0.75,
        minSpeechMs: 1000,
        onSpeechRealStart: () => {
          if (statusRef.current === "speaking") {
            console.log("MicVAD: User interrupted! Halting local playback.");
            document.querySelectorAll('audio').forEach(a => { a.volume = 0; });
          }
        },
        onSpeechEnd: () => {
          document.querySelectorAll('audio').forEach(a => { a.volume = 1; });
        }
      }).then((v: any) => { myVad = v; }).catch(console.error);
    }

    return () => {
      myVad?.destroy();
    };
  }, [connected]);

  // Load topic title for display
  useEffect(() => {
    fetch(`/api/topics/${topicId}`)
      .then((r) => r.json())
      .then((t) => { const topic = t as { title?: string }; if (topic.title) setTopicTitle(topic.title); })
      .catch(() => { });
  }, [topicId]);

  // Auto-start call when connected
  useEffect(() => {
    if (connected && status === "idle") {
      startCall();
    }
  }, [connected, status]);

  // Handle custom messages from VivaAgent
  useEffect(() => {
    if (!lastCustomMessage) return;
    const msg = lastCustomMessage as { type: string;[k: string]: unknown };

    if (msg.type === "viva_state") {
      setPhase((msg.phase as VivaPhase) ?? "idle");
      if (typeof msg.currentIndex === "number") setCurrentIndex(msg.currentIndex);
      if (typeof msg.totalQuestions === "number") setTotalQuestions(msg.totalQuestions);
    }

    if (msg.type === "viva_result") {
      setLiveResults((prev) => [
        ...prev,
        {
          questionNo: msg.questionNo as number,
          question: msg.question as string,
          score: msg.score as number,
          feedback: msg.feedback as string
        }
      ]);
    }
  }, [lastCustomMessage]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  // End call when viva completes
  useEffect(() => {
    if (phase === "complete") {
      const timer = setTimeout(() => endCall(), 4000);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  const handleEndViva = useCallback(() => {
    endCall();
    onExit();
  }, [endCall, onExit]);

  const isInCall = status !== "idle";
  const statusDisplay = getStatusDisplay(status);
  const StatusIcon = statusDisplay.icon;

  const avgScore =
    liveResults.length > 0
      ? Math.round((liveResults.reduce((s, r) => s + r.score, 0) / liveResults.length) * 10) / 10
      : null;

  return (
    <div className="min-h-full p-6">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeftIcon size={16} />}
            onClick={handleEndViva}
          >
            Back
          </Button>
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-xl truncate text-kumo-default">
              {topicTitle || "Viva"}
            </h2>
          </div>
          {isInCall && phase === "active" && (
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-kumo-brand/10 text-kumo-brand flex-shrink-0">
              Q {Math.min(currentIndex + 1, totalQuestions)} / {totalQuestions}
            </span>
          )}
          <ModeToggle />
        </div>

        {/* Connection state */}
        {!connected && (
          <Surface className="rounded-xl ring ring-kumo-line mb-4 px-4 py-3 text-center">
            <div className="flex items-center justify-center gap-2 text-kumo-secondary">
              <SpinnerGapIcon size={18} className="animate-spin" />
              <span className="text-sm">Connecting to viva agent...</span>
            </div>
          </Surface>
        )}

        {/* Error */}
        {error && (
          <div className="mb-4 px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Phase: generating questions */}
        {phase === "generating" && (
          <Surface className="rounded-xl ring ring-kumo-line mb-4 px-4 py-6 text-center">
            <SpinnerGapIcon size={28} className="animate-spin mx-auto mb-3 text-kumo-brand" />
            <p className="text-sm font-medium">Generating examination questions...</p>
            <p className="text-xs text-kumo-secondary mt-1">This may take a few seconds</p>
          </Surface>
        )}

        {/* Question progress bar (active phase) */}
        {phase === "active" && totalQuestions > 0 && (
          <div className="mb-4">
            <div className="flex items-center justify-between text-xs text-kumo-secondary mb-1.5">
              <span>Progress</span>
              <span>{liveResults.length} of {totalQuestions} answered</span>
            </div>
            <div className="h-1.5 bg-kumo-fill rounded-full overflow-hidden">
              <div
                className="h-full bg-kumo-brand rounded-full transition-all duration-500"
                style={{ width: `${(liveResults.length / totalQuestions) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Status indicator */}
        {connected && (
          <Surface className="rounded-xl px-4 py-3 ring ring-kumo-line mb-4">
            <div className={`flex items-center justify-center gap-2 ${statusDisplay.color}`}>
              <StatusIcon
                size={20}
                weight="bold"
                className={status === "thinking" ? "animate-spin" : ""}
              />
              <span className="text-base font-medium">{statusDisplay.text}</span>
            </div>
            {isInCall && status === "listening" && (
              <div className="mt-2 h-1.5 bg-kumo-fill rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full transition-all duration-75"
                  style={{ width: `${Math.min(audioLevel * 500, 100)}%` }}
                />
              </div>
            )}
          </Surface>
        )}

        {/* Shape Visualizer */}
        <div className="flex justify-center items-center my-12 relative h-[300px]">
          <div
            className="transition-all duration-100 ease-out shadow-xl"
            style={{
              width: `${150 + Math.min(audioLevel * 100, 100) + (status === "speaking" ? Math.random() * 20 : 0)}px`,
              height: `${150 + Math.min(audioLevel * 100, 100) + (status === "speaking" ? Math.random() * 20 : 0)}px`,
              borderRadius: status === "speaking"
                ? `${50 + Math.random() * 10}%` // Circle/blobby when speaking
                : `${25 + Math.min(audioLevel * 50, 25)}%`, // Morph from rounded square to circle when user speaks
              backgroundColor: status === "speaking"
                ? "var(--kumo-brand)"
                : status === "listening"
                  ? "rgb(34, 197, 94)" // Green-500
                  : status === "thinking"
                    ? "rgb(245, 158, 11)" // Amber-500
                    : "var(--kumo-line)", // Idle
              transform: status === "thinking" ? "scale(0.9)" : "scale(1)",
              opacity: status === "idle" ? 0.5 : 1
            }}
          />
          {status === "thinking" && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-kumo-secondary animate-pulse">
              Thinking...
            </div>
          )}
        </div>

        {/* Live results after each answer */}
        {liveResults.length > 0 && (
          <div className="mb-4 space-y-2">
            <h3 className="text-xs font-semibold text-kumo-secondary uppercase tracking-wide">Scores so far</h3>
            {liveResults.map((r) => (
              <div
                key={r.questionNo}
                className="flex items-start gap-3 px-3 py-2 rounded-lg bg-kumo-fill/50 border border-kumo-line text-sm"
              >
                <span className="text-kumo-secondary font-medium flex-shrink-0 w-5">Q{r.questionNo}</span>
                <span className="flex-1 min-w-0 text-kumo-secondary italic truncate">{r.feedback}</span>
                <span className={`font-bold tabular-nums flex-shrink-0 ${scoreColor(r.score)}`}>
                  {r.score}/10
                </span>
              </div>
            ))}
            {avgScore !== null && (
              <div className="flex items-center justify-end pt-1">
                <span className="text-xs text-kumo-secondary mr-2">Average so far:</span>
                <span className={`text-sm font-bold tabular-nums ${scoreColor(avgScore)}`}>{avgScore}/10</span>
              </div>
            )}
          </div>
        )}

        {/* Viva complete summary */}
        {phase === "complete" && (
          <Surface className="rounded-xl ring ring-kumo-line mb-4 px-4 py-5">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircleIcon size={20} className="text-green-500" weight="fill" />
              <span className="font-semibold">Viva Complete!</span>
              {avgScore !== null && (
                <span className={`ml-auto text-lg font-bold tabular-nums ${scoreColor(avgScore)}`}>
                  {avgScore}/10 avg
                </span>
              )}
            </div>
            <p className="text-sm text-kumo-secondary">
              Results have been saved. You can view the full breakdown under the topic card.
            </p>
            <Button
              variant="primary"
              className="mt-3 w-full justify-center"
              icon={<ArrowLeftIcon size={16} />}
              onClick={onExit}
            >
              Back to Topics
            </Button>
          </Surface>
        )}

        {/* Controls */}
        {phase !== "complete" && isInCall && (
          <div className="flex items-center justify-center gap-4">
            <Button
              onClick={toggleMute}
              variant={isMuted ? "destructive" : "secondary"}
              icon={
                isMuted ? (
                  <MicrophoneSlashIcon size={20} weight="fill" />
                ) : (
                  <MicrophoneIcon size={20} weight="fill" />
                )
              }
            >
              {isMuted ? "Unmute" : "Mute"}
            </Button>
            <Button
              onClick={handleEndViva}
              variant="destructive"
              icon={<PhoneDisconnectIcon size={20} weight="fill" />}
            >
              End Viva
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// --- App Root ---

function App() {
  const [view, setView] = useState<"topics" | "viva">("topics");
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);

  const handleStartViva = (topicId: string) => {
    setSelectedTopicId(topicId);
    setView("viva");
  };

  const handleExitViva = () => {
    setView("topics");
    setSelectedTopicId(null);
  };

  if (view === "viva" && selectedTopicId) {
    return <VivaPage topicId={selectedTopicId} onExit={handleExitViva} />;
  }

  return <TopicListPage onStartViva={handleStartViva} />;
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
