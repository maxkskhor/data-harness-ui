"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  apiUrl,
  createSession,
  getMe,
  githubLoginUrl,
  getSession,
  getSessionContext,
  getSessionTree,
  logout as apiLogout,
  StreamAborted,
  streamMessage,
  uploadDataset,
  type CacheHandleInfo,
  type ChartEvent,
  type ChatMessage,
  type Me,
  type Session,
  type SessionContext,
  type ToolResultEvent,
  type ToolUseEvent,
  type UploadSummary,
} from "@/lib/api";

type SessionStatus = "starting" | "ready" | "error";
type AuthStatus = "loading" | "ready";

const BYOK_STORAGE_KEY = "data-harness-byok-key";

const QUICK_QUESTIONS = [
  "What columns are in this?",
  "Which numeric column has the highest average?",
];

export default function WorkbenchPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");
  const [byokKey, setByokKey] = useState<string | null>(null);
  const [byokDraft, setByokDraft] = useState("");

  const [session, setSession] = useState<Session | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("starting");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  // Bumped after every completed turn/upload so the Inspector panel (if
  // open) knows to refetch — it does not poll while closed.
  const [inspectorRefresh, setInspectorRefresh] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const latestUpload = session?.uploads.at(-1) ?? null;
  const messageCount = session?.messages.length ?? 0;
  const isSessionReady = sessionStatus === "ready" && session !== null;
  const isBusy = sessionStatus === "starting" || isUploading || isSending;
  const canUseApp = Boolean(me?.login) || Boolean(byokKey);

  const statusLabel = useMemo(() => {
    if (sessionStatus === "starting") {
      return "starting";
    }
    if (sessionStatus === "error") {
      return "error";
    }
    return "live";
  }, [sessionStatus]);

  useEffect(() => {
    setByokKey(sessionStorage.getItem(BYOK_STORAGE_KEY));
    let isMounted = true;
    getMe()
      .then((next) => {
        if (isMounted) {
          setMe(next);
        }
      })
      .catch(() => {
        if (isMounted) {
          setMe(null);
        }
      })
      .finally(() => {
        if (isMounted) {
          setAuthStatus("ready");
        }
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (authStatus !== "ready" || !canUseApp) {
      return;
    }
    let isMounted = true;

    async function startSession() {
      try {
        setSessionStatus("starting");
        setError(null);
        const nextSession = await createSession(byokKey ?? undefined);
        if (!isMounted) {
          return;
        }
        setSession(nextSession);
        setSessionStatus("ready");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setSessionStatus("error");
        setError(errorMessage(err));
      }
    }

    startSession();

    return () => {
      isMounted = false;
    };
  }, [authStatus, canUseApp, byokKey]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messageCount, isSending, isUploading]);

  async function restartSession() {
    setSession(null);
    setDraft("");
    setSessionStatus("starting");
    setError(null);
    try {
      const nextSession = await createSession(byokKey ?? undefined);
      setSession(nextSession);
      setSessionStatus("ready");
    } catch (err) {
      setSessionStatus("error");
      setError(errorMessage(err));
    }
  }

  function saveByokKey(key: string) {
    const trimmed = key.trim();
    if (!trimmed) {
      return;
    }
    sessionStorage.setItem(BYOK_STORAGE_KEY, trimmed);
    setByokKey(trimmed);
    setByokDraft("");
  }

  function clearByokKey() {
    sessionStorage.removeItem(BYOK_STORAGE_KEY);
    setByokKey(null);
  }

  async function handleSignOut() {
    await apiLogout().catch(() => undefined);
    setMe(null);
    setSession(null);
    setSessionStatus("starting");
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    if (!session) {
      setError("Start a session before uploading a data source.");
      return;
    }

    setIsUploading(true);
    setError(null);
    try {
      await uploadDataset(session.id, file);
      setSession(await getSession(session.id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsUploading(false);
      setInspectorRefresh((n) => n + 1);
      event.target.value = "";
    }
  }

  async function handleSubmit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || !session || isSending) {
      return;
    }

    setDraft("");
    setIsSending(true);
    setError(null);
    setSession((current) =>
      current?.id === session.id
        ? {
            ...current,
            messages: [
              ...current.messages,
              { role: "user", content },
              { role: "assistant", content: "" },
            ],
          }
        : current,
    );
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      const nextSession = await streamMessage(
        session.id,
        content,
        (chunk) => {
          if (chunk.type === "chunk") {
            appendAssistantChunk(session.id, chunk.data);
          } else if (chunk.type === "tool_use") {
            appendToolMessage(session.id, toolUseMessage(chunk.data));
          } else if (chunk.type === "tool_result") {
            appendToolMessage(session.id, toolResultMessage(chunk.data));
          } else if (chunk.type === "chart") {
            appendToolMessage(session.id, chartMessage(chunk.data));
          } else if (chunk.type === "answer") {
            setFinalAssistantText(session.id, chunk.data);
          } else {
            setError(chunk.data);
          }
        },
        controller.signal,
      );
      setSession((current) =>
        current && current.id === nextSession.id
          ? { ...nextSession, messages: current.messages }
          : nextSession,
      );
    } catch (err) {
      if (err instanceof StreamAborted) {
        // User-initiated stop: keep whatever streamed in so far, no error.
      } else {
        setDraft(content);
        setError(errorMessage(err));
        setSession(await getSession(session.id).catch(() => session));
      }
    } finally {
      abortControllerRef.current = null;
      setIsSending(false);
      setInspectorRefresh((n) => n + 1);
      textareaRef.current?.focus();
    }
  }

  function handleStop() {
    abortControllerRef.current?.abort();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  }

  function applyQuickQuestion(question: string) {
    setDraft(question);
    textareaRef.current?.focus();
  }

  function appendAssistantChunk(sessionId: string, chunk: string) {
    setSession((current) => {
      if (!current || current.id !== sessionId) {
        return current;
      }
      const messages = [...current.messages];
      const last = messages.at(-1);
      if (last?.role !== "assistant") {
        return current;
      }
      messages[messages.length - 1] = {
        ...last,
        content: `${last.content}${chunk}`,
      };
      return { ...current, messages };
    });
  }

  // The client built its live text by appending raw "chunk" deltas as they
  // streamed in, before the server could resolve any ![title](handle) chart
  // reference to a real URL — this replaces that text with the corrected
  // final version once the stream completes.
  function setFinalAssistantText(sessionId: string, text: string) {
    setSession((current) => {
      if (!current || current.id !== sessionId) {
        return current;
      }
      const messages = [...current.messages];
      const last = messages.at(-1);
      if (last?.role !== "assistant") {
        return current;
      }
      messages[messages.length - 1] = { ...last, content: text };
      return { ...current, messages };
    });
  }

  function appendToolMessage(sessionId: string, message: ChatMessage) {
    setSession((current) => {
      if (!current || current.id !== sessionId) {
        return current;
      }
      const messages = [...current.messages];
      const assistant = messages.at(-1);
      if (assistant?.role === "assistant") {
        messages.splice(messages.length - 1, 0, message);
      } else {
        messages.push(message);
      }
      return { ...current, messages };
    });
  }

  if (authStatus === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <p className="font-mono text-xs text-muted">Checking sign-in status...</p>
      </main>
    );
  }

  if (!canUseApp) {
    return (
      <AuthGate
        byokDraft={byokDraft}
        onByokDraftChange={setByokDraft}
        onSaveKey={saveByokKey}
      />
    );
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen flex-col">
        <header className="border-b border-border bg-background/95 px-4 py-3">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-baseline gap-3">
                <h1 className="font-mono text-sm font-semibold uppercase tracking-wide text-foreground">
                  Data Harness
                </h1>
                <p className="hidden truncate text-xs text-muted sm:block">
                  Ask questions of a CSV. Python sandboxed, no bash.
                </p>
              </div>
              <p className="mt-0.5 truncate font-mono text-xs text-muted">
                session {session?.id.slice(0, 8) ?? "pending"}
              </p>
            </div>
            <div className="flex items-center gap-3 font-mono text-xs text-muted">
              <AccountCluster
                me={me}
                byokActive={Boolean(byokKey)}
                onSignOut={handleSignOut}
                onClearKey={clearByokKey}
              />
              <span className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${
                    sessionStatus === "ready"
                      ? "bg-accent"
                      : sessionStatus === "error"
                        ? "bg-danger"
                        : "bg-muted"
                  }`}
                />
                {statusLabel}
              </span>
              <button
                type="button"
                onClick={restartSession}
                disabled={sessionStatus === "starting"}
                className="h-8 rounded border border-border px-3 text-foreground transition hover:border-accent hover:bg-panel-soft disabled:cursor-not-allowed disabled:opacity-50"
              >
                New session
              </button>
            </div>
          </div>
        </header>

        <div className="mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="flex min-h-[calc(100vh-7rem)] flex-col overflow-hidden rounded-lg border border-border bg-panel">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h2 className="text-sm font-medium text-foreground">Chat</h2>
                <p className="mt-0.5 text-xs text-muted">
                  Ask against the active workbench session.
                </p>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!isSessionReady || isUploading}
                className="h-9 rounded bg-accent px-3 text-sm font-medium text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:bg-panel-soft disabled:text-muted"
              >
                {isUploading ? "Uploading" : "Upload source"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={handleUpload}
                className="hidden"
              />
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-5">
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
                {sessionStatus === "starting" ? (
                  <SystemMessage content="Starting a local session..." />
                ) : null}
                {isSessionReady && messageCount === 0 ? (
                  <SystemMessage content="Upload a data source, then ask a question." />
                ) : null}
                {session?.messages.map((message, index) => (
                  <MessageBubble
                    key={`${message.role}-${index}-${message.content.slice(
                      0,
                      12,
                    )}`}
                    message={message}
                  />
                ))}
                {isUploading ? (
                  <SystemMessage content="Reading the uploaded data source..." />
                ) : null}
                {isSending ? (
                  <SystemMessage content="Streaming the latest answer..." />
                ) : null}
                <div ref={messagesEndRef} />
              </div>
            </div>

            <div className="border-t border-border bg-background/70 p-4">
              {error ? (
                <div className="mb-3 space-y-2 rounded border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
                  <p>{error}</p>
                  {error.toLowerCase().includes("budget") ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        saveByokKey(byokDraft);
                      }}
                      className="flex gap-2"
                    >
                      <input
                        type="password"
                        value={byokDraft}
                        onChange={(event) => setByokDraft(event.target.value)}
                        placeholder="Paste a DeepSeek key to keep going"
                        className="h-8 flex-1 rounded border border-danger/40 bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted"
                      />
                      <button
                        type="submit"
                        disabled={!byokDraft.trim()}
                        className="h-8 rounded border border-danger/40 px-2 text-xs text-danger disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Use key
                      </button>
                    </form>
                  ) : null}
                </div>
              ) : null}

              <div className="mb-3 flex flex-wrap gap-2">
                {QUICK_QUESTIONS.map((question) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => applyQuickQuestion(question)}
                    disabled={!isSessionReady || isBusy}
                    className="rounded border border-border px-3 py-1.5 text-xs text-muted transition hover:border-accent hover:bg-panel-soft disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {question}
                  </button>
                ))}
              </div>

              <form
                onSubmit={handleSubmit}
                className="flex items-end gap-3 rounded-lg border border-border bg-panel p-2"
              >
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  rows={1}
                  placeholder={
                    latestUpload
                      ? "Ask about the active data source"
                      : "Upload a data source, then ask a question"
                  }
                  disabled={!isSessionReady || isSending}
                  className="min-h-11 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-foreground outline-none placeholder:text-muted disabled:cursor-not-allowed"
                />
                {isSending ? (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="h-10 rounded border border-danger/40 bg-danger-soft px-4 text-sm font-semibold text-danger transition hover:opacity-90"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!isSessionReady || !draft.trim()}
                    className="h-10 rounded bg-accent px-4 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:bg-panel-soft disabled:text-muted"
                  >
                    Send
                  </button>
                )}
              </form>
            </div>
          </section>

          <aside className="flex min-h-[24rem] flex-col gap-4 lg:min-h-0">
            <section className="rounded-lg border border-border bg-panel p-4">
              <h2 className="text-sm font-medium text-foreground">Sources</h2>
              {latestUpload ? (
                <UploadSummaryPanel upload={latestUpload} />
              ) : (
                <div className="mt-4 rounded border border-dashed border-border px-3 py-8 text-center text-sm text-muted">
                  No data source loaded
                </div>
              )}
            </section>

            <section className="rounded-lg border border-border bg-panel p-4">
              <h2 className="text-sm font-medium text-foreground">Session</h2>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <Stat label="Messages" value={String(messageCount)} />
                <Stat label="Sources" value={String(session?.uploads.length ?? 0)} />
              </dl>
            </section>

            {session ? (
              <InspectorPanel
                sessionId={session.id}
                refreshSignal={inspectorRefresh}
              />
            ) : null}
          </aside>
        </div>
      </div>
    </main>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "tool") {
    return <ToolTrace message={message} />;
  }

  const isUser = message.role === "user";
  const isChart = Boolean(message.image_url);
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-4 py-3 text-sm leading-6 ${
          isUser
            ? "bg-accent text-accent-foreground"
            : "border border-border bg-background text-foreground"
        }`}
      >
        <div className="mb-1 font-mono text-[11px] font-medium uppercase tracking-wide opacity-70">
          {isUser ? "You" : "Assistant"}
        </div>
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : isChart ? (
          <ChartImage message={message} />
        ) : (
          <MarkdownContent content={message.content} />
        )}
      </div>
    </div>
  );
}

function ChartImage({ message }: { message: ChatMessage }) {
  if (!message.image_url) {
    return null;
  }
  return (
    <ChartCard
      src={apiUrl(message.image_url)}
      title={message.image_title ?? undefined}
    />
  );
}

// Shared by the trailing chart message bubble (ChartImage, above) and any
// ![title](handle) the model references inline in its own answer text
// (resolved server-side to a real chart URL — see MarkdownContent's "image"
// block below) so both look identical regardless of how the chart reached
// the page.
function ChartCard({ src, title }: { src: string; title?: string }) {
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // A fast/local backend can finish loading the image before this effect
  // (and thus the onLoad prop) attaches, which permanently misses the
  // browser's one-shot 'load' event — check `complete` on mount as a
  // fallback so the chart doesn't get stuck invisible at opacity-0.
  useEffect(() => {
    if (imgRef.current?.complete) {
      setLoaded(true);
    }
  }, []);

  return (
    <figure className="space-y-1.5">
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="block overflow-hidden rounded-md border border-border bg-white p-2 shadow-sm transition hover:opacity-95"
      >
        <div className="relative min-w-64">
          {/* width/height give the browser a concrete intrinsic size before
              the image loads — without it, an out-of-flow/unsized image
              contributes nothing to this flex-item bubble's shrink-to-fit
              width, and the whole card collapses to near zero. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- charts are
              served from the backend, not Next's static asset pipeline. */}
          <img
            ref={imgRef}
            src={src}
            alt={title ?? "Chart"}
            width={560}
            height={350}
            onLoad={() => setLoaded(true)}
            className={`h-auto w-full rounded object-contain transition-opacity duration-200 ${
              loaded ? "opacity-100" : "opacity-0"
            }`}
          />
          {!loaded ? (
            <div className="absolute inset-0 animate-pulse rounded bg-black/5" />
          ) : null}
        </div>
      </a>
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{title ?? "Chart"}</span>
        <a
          href={src}
          download
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Download
        </a>
      </div>
    </figure>
  );
}

function ToolTrace({ message }: { message: ChatMessage }) {
  const isError = Boolean(message.isError);
  return (
    <div
      className={`w-full max-w-[85%] rounded-r border-l-2 px-3 py-2 font-mono text-xs leading-5 ${
        isError
          ? "border-danger bg-danger-soft text-danger"
          : "border-tool bg-tool-soft text-tool"
      }`}
    >
      <div className="mb-1 flex items-center gap-2 uppercase tracking-wide">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            isError ? "bg-danger" : "bg-tool"
          }`}
        />
        {message.title ?? "Tool"}
      </div>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-foreground/80">
        {message.content}
      </pre>
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  if (!content) {
    return <p className="text-muted">...</p>;
  }

  const blocks = splitMarkdownBlocks(content);
  return (
    <div className="space-y-3 break-words">
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <pre
              key={index}
              className="overflow-auto rounded border border-border bg-background p-3 font-mono text-xs leading-5 text-foreground"
            >
              <code>{block.content}</code>
            </pre>
          );
        }
        if (block.type === "heading") {
          return (
            <h3 key={index} className="text-base font-semibold text-foreground">
              {renderInlineMarkdown(block.content)}
            </h3>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={index} className="list-disc space-y-1 pl-5">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "image") {
          return (
            <ChartCard key={index} src={apiUrl(block.src)} title={block.alt || undefined} />
          );
        }
        if (block.type === "table") {
          return (
            <div
              key={index}
              className="overflow-auto rounded border border-border"
            >
              <table className="min-w-full border-collapse text-left text-xs">
                <thead className="bg-panel text-muted">
                  <tr>
                    {block.header.map((cell, cellIndex) => (
                      <th
                        key={cellIndex}
                        scope="col"
                        className="border-b border-border px-2 py-1.5 font-mono font-medium"
                      >
                        {renderInlineMarkdown(cell)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} className="px-2 py-1.5">
                          {renderInlineMarkdown(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <p key={index} className="whitespace-pre-wrap">
            {renderInlineMarkdown(block.content)}
          </p>
        );
      })}
    </div>
  );
}

type MarkdownBlock =
  | { type: "code"; content: string }
  | { type: "heading"; content: string }
  | { type: "list"; items: string[] }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "image"; alt: string; src: string }
  | { type: "paragraph"; content: string };

const STANDALONE_IMAGE_LINE = /^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/;

const TABLE_SEPARATOR_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function splitMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] | null = null;

  function flushParagraph() {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", content: paragraph.join("\n") });
      paragraph = [];
    }
  }

  function flushList() {
    if (list.length > 0) {
      blocks.push({ type: "list", items: list });
      list = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      if (code === null) {
        flushParagraph();
        flushList();
        code = [];
      } else {
        blocks.push({ type: "code", content: code.join("\n") });
        code = null;
      }
      continue;
    }

    if (code !== null) {
      code.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    // A chart reference on its own line: ![title](url). The backend only
    // ever emits a resolved, absolute-path url here (an unresolvable handle
    // is stripped server-side), so this always renders as a real chart.
    const standaloneImage = line.match(STANDALONE_IMAGE_LINE);
    if (standaloneImage) {
      flushParagraph();
      flushList();
      blocks.push({ type: "image", alt: standaloneImage[1], src: standaloneImage[2] });
      continue;
    }

    // A GFM pipe table: a `| ... |` row followed by a `|---|---|`-style
    // separator row. Consume rows until a blank line or a line that isn't
    // itself a pipe row.
    if (
      line.trim().startsWith("|") &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR_ROW.test(lines[i + 1])
    ) {
      flushParagraph();
      flushList();
      const header = parseTableRow(line);
      const rows: string[][] = [];
      i += 2; // skip the header row and the separator row
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      i--; // the outer for-loop's increment accounts for the last row consumed
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", content: heading[1] });
      continue;
    }

    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      list.push(listItem[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  if (code !== null) {
    blocks.push({ type: "code", content: code.join("\n") });
  }
  flushParagraph();
  flushList();
  return blocks;
}

const INLINE_IMAGE = /^!\[([^\]]*)\]\(([^)]+)\)$/;

function renderInlineMarkdown(content: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // A standalone image line is handled as its own block (full ChartCard
  // treatment, see splitMarkdownBlocks) — this inline case only covers the
  // rarer case of a chart reference sitting mid-sentence, where it gets a
  // plain inline image instead (a <div>-based card isn't valid inside <p>).
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|!\[[^\]]*\]\([^)]+\))/g;
  let lastIndex = 0;

  for (const match of content.matchAll(pattern)) {
    if (match.index > lastIndex) {
      nodes.push(content.slice(lastIndex, match.index));
    }
    const token = match[0];
    const image = token.match(INLINE_IMAGE);
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={nodes.length} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (image) {
      // eslint-disable-next-line @next/next/no-img-element -- backend-served
      nodes.push(
        <img
          key={nodes.length}
          src={apiUrl(image[2])}
          alt={image[1] || "Chart"}
          className="inline-block max-h-48 max-w-full rounded border border-border bg-white p-1 align-middle"
        />,
      );
    } else {
      nodes.push(
        <code
          key={nodes.length}
          className="rounded bg-panel-soft px-1 py-0.5 font-mono text-xs text-accent"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < content.length) {
    nodes.push(content.slice(lastIndex));
  }
  return nodes;
}

function toolUseMessage(event: ToolUseEvent): ChatMessage {
  const name = event.name ?? "tool";
  return {
    role: "tool",
    kind: "tool_use",
    title: `call · ${name}`,
    content: formatToolPayload(event.input ?? {}),
  };
}

function toolResultMessage(event: ToolResultEvent): ChatMessage {
  return {
    role: "tool",
    kind: "tool_result",
    title: event.is_error ? "error" : "result",
    content: event.content ?? "",
    isError: event.is_error ?? false,
  };
}

function chartMessage(event: ChartEvent): ChatMessage {
  return {
    role: "assistant",
    content: "",
    image_url: event.url,
    image_format: event.format,
    image_title: event.title ?? null,
  };
}

function formatToolPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function SystemMessage({ content }: { content: string }) {
  return (
    <div className="mx-auto rounded border border-border bg-background px-3 py-2 font-mono text-xs text-muted">
      {content}
    </div>
  );
}

type InspectorTab = "context" | "record";

// data-harness's two selling points made visible: exactly what's in the
// model's context right now (real per-turn token accounting, not an
// estimate, plus every cache handle and where it physically lives), and the
// append-only session record in the same JSONL format a real
// JsonlSessionStore would have written to disk.
function InspectorPanel({
  sessionId,
  refreshSignal,
}: {
  sessionId: string;
  refreshSignal: number;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<InspectorTab>("context");
  const [context, setContext] = useState<SessionContext | null>(null);
  const [tree, setTree] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const request =
      tab === "context"
        ? getSessionContext(sessionId).then((data) => {
            if (!cancelled) setContext(data);
          })
        : getSessionTree(sessionId).then((data) => {
            if (!cancelled) setTree(data);
          });
    request
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab, sessionId, refreshSignal]);

  function downloadTree() {
    if (!tree) {
      return;
    }
    const blob = new Blob([tree], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${sessionId}.jsonl`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div>
          <h2 className="text-sm font-medium text-foreground">Inspector</h2>
          <p className="mt-0.5 text-xs text-muted">
            Live context and the raw session record.
          </p>
        </div>
        <span className="shrink-0 text-xs text-muted">
          {open ? "Hide" : "Show"}
        </span>
      </button>

      {open ? (
        <div className="mt-4 space-y-3">
          <div className="flex gap-2">
            <TabButton
              active={tab === "context"}
              onClick={() => setTab("context")}
            >
              Context
            </TabButton>
            <TabButton
              active={tab === "record"}
              onClick={() => setTab("record")}
            >
              Session record
            </TabButton>
          </div>

          {loading ? (
            <p className="text-xs text-muted">Loading...</p>
          ) : error ? (
            <p className="text-xs text-danger">{error}</p>
          ) : tab === "context" ? (
            context ? <ContextInspector context={context} /> : null
          ) : tree ? (
            <div className="space-y-2">
              <pre className="max-h-72 overflow-auto rounded border border-border bg-background p-3 font-mono text-[11px] leading-5 text-foreground/80">
                {tree}
              </pre>
              <button
                type="button"
                onClick={downloadTree}
                className="text-xs text-muted underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                Download .jsonl
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2.5 py-1 text-xs transition ${
        active
          ? "border-accent bg-accent/10 text-accent"
          : "border-border text-muted hover:border-accent hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function ContextInspector({ context }: { context: SessionContext }) {
  // max_turns caps a single exchange, not the whole chat (data-harness
  // resets the turn counter at the start of every ask_result() call) — so
  // the progress bar tracks last_turn_used against it, not the lifetime
  // session_turns total, which is shown separately as a plain count.
  const lastTurnPct =
    context.max_turns > 0
      ? Math.min(100, Math.round((context.last_turn_used / context.max_turns) * 100))
      : 0;
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between text-xs text-muted">
          <span>Last exchange</span>
          <span>
            {context.last_turn_used} / {context.max_turns} turns
          </span>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-panel-soft">
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${lastTurnPct}%` }}
          />
        </div>
        <div className="mt-1 text-xs text-muted">
          {context.session_turns} turns total this session
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <Stat label="Input tokens" value={context.input_tokens.toLocaleString()} />
        <Stat label="Output tokens" value={context.output_tokens.toLocaleString()} />
        <Stat label="Cache read" value={context.cache_read_tokens.toLocaleString()} />
        <Stat label="Cache write" value={context.cache_write_tokens.toLocaleString()} />
      </dl>

      <div>
        <h3 className="font-mono text-xs font-medium uppercase tracking-wide text-muted">
          Cache handles ({context.handles.length})
        </h3>
        {context.handles.length > 0 ? (
          <div className="mt-2 space-y-2">
            {context.handles.map((handle) => (
              <CacheHandleRow key={handle.name} handle={handle} />
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted">Nothing in the cache yet.</p>
        )}
      </div>
    </div>
  );
}

function CacheHandleRow({ handle }: { handle: CacheHandleInfo }) {
  return (
    <div className="rounded border border-border bg-background p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs text-accent">
          {handle.name}
        </span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
            handle.location === "disk"
              ? "bg-tool-soft text-tool"
              : "bg-panel-soft text-muted"
          }`}
        >
          {handle.location}
        </span>
      </div>
      <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-muted">
        {handle.snapshot}
      </pre>
    </div>
  );
}

function UploadSummaryPanel({ upload }: { upload: UploadSummary }) {
  const previewColumns = upload.columns.slice(0, 8);

  return (
    <div className="mt-4 space-y-4">
      <div className="rounded border border-border bg-background p-3">
        <div className="truncate text-sm font-medium text-foreground">
          {upload.filename}
        </div>
        <div className="mt-1 font-mono text-xs text-accent">
          {upload.handle}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <Stat label="Rows" value={upload.rows.toLocaleString()} />
          <Stat label="Columns" value={String(upload.columns.length)} />
        </dl>
      </div>

      <div>
        <h3 className="font-mono text-xs font-medium uppercase tracking-wide text-muted">
          Columns
        </h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {upload.columns.map((column) => (
            <span
              key={column}
              className="max-w-full truncate rounded border border-border px-2 py-1 font-mono text-xs text-muted"
              title={column}
            >
              {column}
            </span>
          ))}
        </div>
      </div>

      <div>
        <h3 className="font-mono text-xs font-medium uppercase tracking-wide text-muted">
          Preview
        </h3>
        {upload.preview.length > 0 ? (
          <div className="mt-2 max-h-72 overflow-auto rounded border border-border">
            <table className="min-w-full table-fixed border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-panel text-muted">
                <tr>
                  {previewColumns.map((column) => (
                    <th
                      key={column}
                      scope="col"
                      className="w-32 border-b border-border px-2 py-2 font-mono font-medium"
                    >
                      <span className="block truncate" title={column}>
                        {column}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-background">
                {upload.preview.map((row, index) => (
                  <tr key={index}>
                    {previewColumns.map((column) => (
                      <td key={column} className="px-2 py-2 text-foreground/80">
                        <span className="block truncate" title={formatCell(row[column])}>
                          {formatCell(row[column])}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-2 rounded border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
            No preview rows
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-background p-3">
      <dt className="font-mono text-xs text-muted">{label}</dt>
      <dd className="mt-1 truncate font-mono text-sm font-medium text-foreground">
        {value}
      </dd>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toLocaleString() : String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function AuthGate({
  byokDraft,
  onByokDraftChange,
  onSaveKey,
}: {
  byokDraft: string;
  onByokDraftChange: (value: string) => void;
  onSaveKey: (key: string) => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-sm rounded-lg border border-border bg-panel p-6">
        <h1 className="font-mono text-sm font-semibold uppercase tracking-wide text-foreground">
          Data Harness
        </h1>
        <p className="mt-1 text-xs text-muted">
          Ask questions of a CSV. Python sandboxed, no bash.
        </p>

        <a
          href={githubLoginUrl()}
          className="mt-6 flex h-10 items-center justify-center rounded bg-accent text-sm font-semibold text-accent-foreground transition hover:opacity-90"
        >
          Sign in with GitHub
        </a>
        <p className="mt-2 text-center text-xs text-muted">
          Gives you a small shared budget on the house.
        </p>

        <div className="my-5 flex items-center gap-3 text-xs text-muted">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSaveKey(byokDraft);
          }}
          className="space-y-2"
        >
          <label className="block text-xs text-muted">
            Bring your own DeepSeek API key
          </label>
          <input
            type="password"
            value={byokDraft}
            onChange={(event) => onByokDraftChange(event.target.value)}
            placeholder="sk-..."
            className="h-10 w-full rounded border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted focus:border-accent"
          />
          <button
            type="submit"
            disabled={!byokDraft.trim()}
            className="h-9 w-full rounded border border-border text-sm text-foreground transition hover:border-accent hover:bg-panel-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            Use this key
          </button>
          <p className="text-xs text-muted">
            Kept in this browser tab only, sent per request, never stored on
            the server.
          </p>
        </form>
      </div>
    </main>
  );
}

function AccountCluster({
  me,
  byokActive,
  onSignOut,
  onClearKey,
}: {
  me: Me | null;
  byokActive: boolean;
  onSignOut: () => void;
  onClearKey: () => void;
}) {
  if (byokActive) {
    return (
      <span className="flex items-center gap-2">
        <span className="rounded border border-accent/40 px-1.5 py-0.5 text-accent">
          byok
        </span>
        <button
          type="button"
          onClick={onClearKey}
          className="text-muted underline-offset-2 hover:text-foreground hover:underline"
        >
          clear key
        </button>
      </span>
    );
  }

  if (!me?.login) {
    return null;
  }

  const remaining = me.budget_remaining_cents ?? 0;
  const low = remaining <= me.budget_total_cents * 0.1;

  return (
    <span className="flex items-center gap-2">
      {me.avatar_url ? (
        <img
          src={me.avatar_url}
          alt={me.login}
          className="h-4 w-4 rounded-full"
        />
      ) : null}
      <span className="text-foreground">{me.login}</span>
      <span className={low ? "text-danger" : "text-muted"}>
        ${(remaining / 100).toFixed(2)} left
      </span>
      <button
        type="button"
        onClick={onSignOut}
        className="text-muted underline-offset-2 hover:text-foreground hover:underline"
      >
        sign out
      </button>
    </span>
  );
}
