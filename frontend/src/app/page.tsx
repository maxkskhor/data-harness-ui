"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  createSession,
  getSession,
  streamMessage,
  uploadDataset,
  type ChatMessage,
  type Session,
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
      return "Starting session";
    }
    if (sessionStatus === "error") {
      return "Session error";
    }
    return "Local session";
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
        setSession((current) => {
          if (!current || current.id !== session.id) {
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
      });
      setSession(nextSession);
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

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="flex min-h-screen flex-col">
        <header className="border-b border-zinc-800 bg-zinc-950/95 px-4 py-3">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-sm font-semibold tracking-normal text-zinc-100">
                Data Harness
              </h1>
              <p className="mt-0.5 truncate text-xs text-zinc-500">
                Session {session?.id.slice(0, 8) ?? "pending"}
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs text-zinc-400">
              <span className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${
                    sessionStatus === "ready"
                      ? "bg-emerald-400"
                      : sessionStatus === "error"
                        ? "bg-red-400"
                        : "bg-amber-300"
                  }`}
                />
                {statusLabel}
              </span>
              <button
                type="button"
                onClick={restartSession}
                disabled={sessionStatus === "starting"}
                className="h-8 rounded border border-zinc-700 px-3 text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                New session
              </button>
            </div>
          </div>
        </header>

        <div className="mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="flex min-h-[calc(100vh-7rem)] flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <div>
                <h2 className="text-sm font-medium text-zinc-100">Chat</h2>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Ask against the active workbench session.
                </p>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!isSessionReady || isUploading}
                className="h-9 rounded bg-zinc-100 px-3 text-sm font-medium text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
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

            <div className="border-t border-zinc-800 bg-zinc-950/70 p-4">
              {error ? (
                <div className="mb-3 rounded border border-red-900/70 bg-red-950/40 px-3 py-2 text-sm text-red-200">
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
                    className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {question}
                  </button>
                ))}
              </div>

              <form
                onSubmit={handleSubmit}
                className="flex items-end gap-3 rounded-lg border border-zinc-700 bg-zinc-900 p-2"
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
                  className="min-h-11 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 disabled:cursor-not-allowed"
                />
                <button
                  type="submit"
                  disabled={!isSessionReady || !draft.trim() || isSending}
                  className="h-10 rounded bg-emerald-300 px-4 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
                >
                  Send
                </button>
              </form>
            </div>
          </section>

          <aside className="flex min-h-[24rem] flex-col gap-4 lg:min-h-0">
            <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <h2 className="text-sm font-medium text-zinc-100">Sources</h2>
              {latestUpload ? (
                <UploadSummaryPanel upload={latestUpload} />
              ) : (
                <div className="mt-4 rounded border border-dashed border-zinc-700 px-3 py-8 text-center text-sm text-zinc-500">
                  No data source loaded
                </div>
              )}
            </section>

            <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <h2 className="text-sm font-medium text-zinc-100">Session</h2>
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
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-4 py-3 text-sm leading-6 ${
          isUser
            ? "bg-emerald-300 text-zinc-950"
            : "border border-zinc-800 bg-zinc-950 text-zinc-100"
        }`}
      >
        <div className="mb-1 text-[11px] font-medium uppercase tracking-normal opacity-70">
          {isUser ? "You" : "Assistant"}
        </div>
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
      </div>
    </div>
  );
}

function SystemMessage({ content }: { content: string }) {
  return (
    <div className="mx-auto rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-500">
      {content}
    </div>
  );
}

function UploadSummaryPanel({ upload }: { upload: UploadSummary }) {
  const previewColumns = upload.columns.slice(0, 8);

  return (
    <div className="mt-4 space-y-4">
      <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
        <div className="truncate text-sm font-medium text-zinc-100">
          {upload.filename}
        </div>
        <div className="mt-1 font-mono text-xs text-emerald-300">
          {upload.handle}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <Stat label="Rows" value={upload.rows.toLocaleString()} />
          <Stat label="Columns" value={String(upload.columns.length)} />
        </dl>
      </div>

      <div>
        <h3 className="text-xs font-medium uppercase tracking-normal text-zinc-500">
          Columns
        </h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {upload.columns.map((column) => (
            <span
              key={column}
              className="max-w-full truncate rounded border border-zinc-700 px-2 py-1 font-mono text-xs text-zinc-300"
              title={column}
            >
              {column}
            </span>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-xs font-medium uppercase tracking-normal text-zinc-500">
          Preview
        </h3>
        {upload.preview.length > 0 ? (
          <div className="mt-2 max-h-72 overflow-auto rounded border border-zinc-800">
            <table className="min-w-full table-fixed border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-zinc-900 text-zinc-400">
                <tr>
                  {previewColumns.map((column) => (
                    <th
                      key={column}
                      scope="col"
                      className="w-32 border-b border-zinc-800 px-2 py-2 font-medium"
                    >
                      <span className="block truncate" title={column}>
                        {column}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 bg-zinc-950">
                {upload.preview.map((row, index) => (
                  <tr key={index}>
                    {previewColumns.map((column) => (
                      <td key={column} className="px-2 py-2 text-zinc-300">
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
          <div className="mt-2 rounded border border-dashed border-zinc-700 px-3 py-6 text-center text-sm text-zinc-500">
            No preview rows
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-1 truncate text-sm font-medium text-zinc-100">{value}</dd>
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
