/**
 * Slack {@link Connector} — wraps the @slack/bolt Socket Mode adapter that
 * used to live in src/slack/serve.ts. Pure handler logic (handler.ts) and
 * config loader (config.ts) are reused unchanged.
 *
 * Lifecycle:
 *   start() → instantiate Bolt App, auth.test for botUserId, subscribe to
 *             app.message (DMs) + app.event("app_mention"), then app.start().
 *             If anything throws, state.error is recorded and status reports
 *             not ready — the gateway runtime treats it as a failed start.
 *   stop()  → idempotent app.stop().
 *   status()→ derived from internal state; never opens sockets.
 */
import type { Connector, ConnectorDoctor, ConnectorStatus } from "../connector.js";
import {
  ensureSlackAllowedUsersConfigured,
  isSlackAllowAll,
  type SlackConfig,
} from "../../slack/config.js";
import {
  handleSlackMessage,
  type SlackHandlerDeps,
  type SlackMessageInput,
} from "../../slack/handler.js";
import { resolveSession } from "../../comms/resolve-session.js";
import { commsAsk } from "../../comms/index.js";

// Minimal shape of the bits of @slack/bolt we use, so the connector is testable
// without importing the real package. The real Bolt import is performed lazily
// inside start() so dynamic imports keep `omp help` fast.
export interface BoltLike {
  client: { auth: { test: () => Promise<{ user_id?: string }> } };
  start: () => Promise<unknown>;
  stop: () => Promise<unknown>;
  message: (handler: (args: { message: SlackMessage; say: SaySig }) => Promise<void>) => void;
  event: (
    name: "app_mention",
    handler: (args: { event: SlackMessage; say: SaySig }) => Promise<void>,
  ) => void;
}

export type AppFactory = (config: SlackConfig) => BoltLike;
export type SaySig = (msg: { text: string; thread_ts?: string }) => Promise<unknown>;

export interface SlackMessage {
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  channel_type?: string;
  thread_ts?: string;
  ts?: string;
}

export interface SlackConnectorOptions {
  config: SlackConfig;
  /** Inject an App factory for testing; default lazy-loads @slack/bolt. */
  appFactory?: AppFactory;
  /** Inject handler deps for testing; default wires comms resolveSession + commsAsk. */
  handlerDeps?: Omit<SlackHandlerDeps, "allowedUsers" | "requireMention" | "sessionEnv">;
  /** Logger; defaults to console.error. */
  log?: (msg: string) => void;
}

export const SLACK_CONNECTOR_NAME = "slack";
const MAX_PENDING_PER_SESSION = 3;
const SESSION_QUEUE_CAPACITY = 1 + MAX_PENDING_PER_SESSION;
const BUSY_ERROR = "worker busy, try again shortly";

interface SessionQueue {
  /** Promise chain for accepted requests; rejections are swallowed here so the chain advances. */
  tail: Promise<void>;
  /** Accepted requests that have not settled yet: one in-flight plus pending items. */
  depth: number;
}

async function defaultAppFactory(config: SlackConfig): Promise<BoltLike> {
  const bolt = await import("@slack/bolt");
  // Bolt is CJS; default-import under NodeNext.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Mod = bolt as any;
  const App = Mod.App ?? Mod.default?.App;
  if (!App) throw new Error("@slack/bolt: App export not found");
  return new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
  }) as BoltLike;
}

/**
 * Build a Slack {@link Connector}. The factory is sync; all I/O happens in
 * `start()`.
 */
export function createSlackConnector(opts: SlackConnectorOptions): Connector {
  const { config, appFactory, handlerDeps, log = (m) => console.error(m) } = opts;

  let app: BoltLike | undefined;
  let started = false;
  let stopping = false;
  let botUserId: string | undefined;
  let lastError: string | undefined;
  const sessionQueues = new Map<string, SessionQueue>();

  const baseAsk = handlerDeps?.ask ?? ((session: string, text: string) => commsAsk(session, text));

  function enqueueAsk(session: string, text: string): ReturnType<SlackHandlerDeps["ask"]> {
    let queue = sessionQueues.get(session);
    if (!queue) {
      queue = { tail: Promise.resolve(), depth: 0 };
      sessionQueues.set(session, queue);
    }

    if (queue.depth >= SESSION_QUEUE_CAPACITY) {
      return Promise.resolve({ ok: false, session, sent: false, error: BUSY_ERROR });
    }

    queue.depth++;
    const run = queue.tail.then(() => baseAsk(session, text));
    const settled = run.finally(() => {
      queue.depth--;
    });
    let tail: Promise<void> = Promise.resolve();
    tail = settled.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (queue.depth === 0 && sessionQueues.get(session) === queue && queue.tail === tail) {
        sessionQueues.delete(session);
      }
    });
    queue.tail = tail;
    return settled;
  }

  const baseDeps: SlackHandlerDeps = {
    resolve: handlerDeps?.resolve ?? ((o) => resolveSession(o)),
    ask: enqueueAsk,
    allowedUsers: config.allowedUsers,
    requireMention: config.requireMention,
    sessionEnv: config.sessionEnv,
  };

  async function respond(input: SlackMessageInput, say: SaySig): Promise<void> {
    try {
      const res = await handleSlackMessage(input, baseDeps);
      if (res.reply) await say({ text: res.reply, thread_ts: res.threadTs });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`omp slack: handler error: ${msg}`);
      try {
        await say({ text: ":warning: internal error handling your message.", thread_ts: input.threadTs });
      } catch {
        /* best effort */
      }
    }
  }

  return {
    name: SLACK_CONNECTOR_NAME,

    async start(): Promise<void> {
      if (started) return;
      try {
        ensureSlackAllowedUsersConfigured(config.allowedUsers);
        if (isSlackAllowAll(config.allowedUsers)) {
          log("omp slack: WARNING: SLACK_ALLOWED_USERS=* allows every Slack workspace user to reach this Copilot session.");
        }

        app = appFactory ? appFactory(config) : await defaultAppFactory(config);
        const auth = await app.client.auth.test();
        botUserId = auth.user_id;

        app.message(async ({ message, say }) => {
          if (message.subtype || message.bot_id || message.user === botUserId) return;
          if (message.channel_type !== "im") return; // DMs only
          await respond(
            {
              text: message.text ?? "",
              userId: message.user,
              channelType: "im",
              isMention: false,
              // Only stay in-thread when the user wrote IN a thread. For top-level
              // DMs we post inline — Slack hides DM thread replies under a
              // "View thread" link, which makes the reply look like it never arrived.
              threadTs: message.thread_ts,
              botUserId,
            },
            say,
          );
        });

        app.event("app_mention", async ({ event, say }) => {
          if (event.bot_id || event.user === botUserId) return;
          await respond(
            {
              text: event.text ?? "",
              userId: event.user,
              channelType: "channel",
              isMention: true,
              threadTs: event.thread_ts ?? event.ts,
              botUserId,
            },
            say,
          );
        });

        await app.start();
        started = true;
        lastError = undefined;
        log(`omp slack: connected via Socket Mode as ${botUserId ?? "bot"} — listening for DMs and @mentions.`);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // Clean up partial state so a retry can proceed.
        if (app) {
          try {
            await app.stop();
          } catch {
            /* ignore */
          }
        }
        app = undefined;
        started = false;
        throw err;
      }
    },

    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      try {
        if (app && started) {
          try {
            await app.stop();
          } catch (err) {
            log(`omp slack: stop error (ignored): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } finally {
        app = undefined;
        started = false;
        stopping = false;
      }
    },

    status(): ConnectorStatus {
      if (started) return { ready: true };
      if (lastError) return { ready: false, detail: lastError };
      return { ready: false, detail: "not started" };
    },
  };
}

/**
 * Static readiness check (no sockets opened). True when both tokens are
 * present in the loaded config AND a Copilot tmux session can be resolved.
 */
export function slackDoctor(config: SlackConfig | null, errorIfNoConfig?: string): ConnectorDoctor {
  return {
    name: SLACK_CONNECTOR_NAME,
    doctor(): ConnectorStatus {
      if (!config) return { ready: false, detail: errorIfNoConfig ?? "missing slack tokens" };
      try {
        ensureSlackAllowedUsersConfigured(config.allowedUsers);
      } catch (err) {
        return { ready: false, detail: err instanceof Error ? err.message : String(err) };
      }
      const resolved = resolveSession({ env: config.sessionEnv });
      if (!resolved.ok) return { ready: false, detail: resolved.error };
      return { ready: true, detail: `session=${resolved.session}` };
    },
  };
}
