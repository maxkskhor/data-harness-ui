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
  createSession,
  getSession,
  streamMessage,
  uploadDataset,
  type ChatMessage,
  type Session,
  type ToolResultEvent,
  type ToolUseEvent,
  type UploadSummary,
} from "@/lib/api";

type SessionStatus = "starting" | "ready" | "error";

const QUICK_QUESTIONS = [
  "What columns are in this?",
  "Which numeric column has the highest average?",
];

export default function WorkbenchPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("starting");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isSending, setIsSending] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const latestUpload = session?.uploads.at(-1) ?? null;
  const messageCount = session?.messages.length ?? 0;
  const isSessionReady = sessionStatus === "ready" && session !== null;
  const isBusy = sessionStatus === "starting" || isUploading || isSending;

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
    let isMounted = true;

    async function startSession() {
      try {
        setSessionStatus("starting");
        setError(null);
        const nextSession = await createSession();
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
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messageCount, isSending, isUploading]);

  async function restartSession() {
    setSession(null);
    setDraft("");
    setSessionStatus("starting");
    setError(null);
    try {
      const nextSession = await createSession();
      setSession(nextSession);
      setSessionStatus("ready");
    } catch (err) {
      setSessionStatus("error");
      setError(errorMessage(err));
    }
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
    try {
      const nextSession = await streamMessage(session.id, content, (chunk) => {
        if (chunk.type === "chunk") {
          appendAssistantChunk(session.id, chunk.data);
        } else if (chunk.type === "tool_use") {
          appendToolMessage(session.id, toolUseMessage(chunk.data));
        } else if (chunk.type === "tool_result") {
          appendToolMessage(session.id, toolResultMessage(chunk.data));
        } else {
          setError(chunk.data);
        }
      });
      setSession((current) =>
        current && current.id === nextSession.id
          ? { ...nextSession, messages: current.messages }
          : nextSession,
      );
    } catch (err) {
      setDraft(content);
      setError(errorMessage(err));
      setSession(await getSession(session.id).catch(() => session));
    } finally {
      setIsSending(false);
      textareaRef.current?.focus();
    }
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
                <div className="mb-3 rounded border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
                  {error}
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
                <button
                  type="submit"
                  disabled={!isSessionReady || !draft.trim() || isSending}
                  className="h-10 rounded bg-accent px-4 text-sm font-semibold text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:bg-panel-soft disabled:text-muted"
                >
                  Send
                </button>
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
        ) : (
          <MarkdownContent content={message.content} />
        )}
      </div>
    </div>
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
  | { type: "paragraph"; content: string };

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

  for (const line of lines) {
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

function renderInlineMarkdown(content: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;

  for (const match of content.matchAll(pattern)) {
    if (match.index > lastIndex) {
      nodes.push(content.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={nodes.length} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
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
