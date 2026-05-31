/**
 * Thin @slack/bolt adapter (Socket Mode) wiring Slack events to the pure
 * {@link handleSlackMessage} bridge. All decision logic lives in handler.ts.
 *
 * Event routing (no channel-message firehose; only DMs + explicit mentions):
 * - DMs        → `app.message` filtered to `channel_type === "im"`
 * - @mentions  → `app.event("app_mention")` (channels)
 *
 * Each listener has an error boundary so a failure never escapes as an
 * unhandled rejection; after a request is accepted the user gets a reply.
 * The process stays alive until SIGINT/SIGTERM, then stops Bolt cleanly.
 */
import bolt from "@slack/bolt";
import type { SlackConfig } from "./config.js";
import { handleSlackMessage, type SlackHandlerDeps, type SlackMessageInput } from "./handler.js";
import { resolveSession } from "../comms/resolve-session.js";
import { commsAsk } from "../comms/index.js";

const { App } = bolt;

export async function runSlackBot(config: SlackConfig): Promise<void> {
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
  });

  const auth = (await app.client.auth.test()) as { user_id?: string };
  const botUserId = auth.user_id;

  const deps: SlackHandlerDeps = {
    resolve: (opts) => resolveSession(opts),
    ask: (session, text) => commsAsk(session, text),
    allowedUsers: config.allowedUsers,
    requireMention: config.requireMention,
    sessionEnv: config.sessionEnv,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function respond(input: SlackMessageInput, say: any): Promise<void> {
    try {
      const res = await handleSlackMessage(input, deps);
      if (res.reply) await say({ text: res.reply, thread_ts: res.threadTs });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`omp slack: handler error: ${msg}`);
      try {
        await say({ text: ":warning: internal error handling your message.", thread_ts: input.threadTs });
      } catch {
        /* best effort */
      }
    }
  }

  // DMs only (channels handled by app_mention; we don't subscribe to the firehose).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.message(async (args: any) => {
    const { message, say } = args;
    if (message.subtype || message.bot_id || message.user === botUserId) return;
    if (message.channel_type !== "im") return; // DMs only
    await respond(
      {
        text: message.text ?? "",
        userId: message.user,
        channelType: "im",
        isMention: false,
        threadTs: message.thread_ts ?? message.ts,
        botUserId,
      },
      say,
    );
  });

  // Channel @mentions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.event("app_mention", async (args: any) => {
    const { event, say } = args;
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
  console.error(
    `omp slack: connected via Socket Mode as ${botUserId ?? "bot"} — listening for DMs and @mentions.`,
  );

  // Block until terminated, then stop Bolt cleanly.
  await new Promise<void>((resolve) => {
    const shutdown = async (sig: string) => {
      console.error(`omp slack: received ${sig}, shutting down…`);
      try {
        await app.stop();
      } catch {
        /* ignore */
      }
      resolve();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
}
