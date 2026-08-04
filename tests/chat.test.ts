import { describe, expect, it } from "vitest";
import { buildChatPrompt, createChat, extractReply, filterRuntimeNoticeLines } from "../src/chat.js";
import { DEFAULT_CHAT_PROMPT_PREAMBLE, REPLY_CLOSE_TAG, REPLY_OPEN_TAG, STATE_KEYS } from "../src/constants.js";
import { FakeGateway, makeCtx, TEST_CONFIG } from "./helpers.js";

function setup(configOverrides = {}) {
  const bundle = makeCtx(configOverrides);
  const gateway = new FakeGateway();
  const chat = createChat({
    ctx: bundle.ctx,
    gateway,
    getConfig: async () => ({ ...TEST_CONFIG, ...configOverrides }),
    updateIntervalMs: 0,
  });
  return { ...bundle, gateway, chat };
}

const dm = (text: string, ts: string, threadTs?: string) => ({
  channel: "D1", channelType: "im" as const, user: "U1", text, ts, threadTs,
});

describe("chat", () => {
  it("creates a session for a new DM thread and posts the agent reply", async () => {
    const { ctx, gateway, chat, stateStore } = setup();
    await chat.handleMessage(dm("hi", "100.1"));
    expect(ctx.agents.sessions.create).toHaveBeenCalledWith("agent-1", "co-1", expect.anything());
    // placeholder post then updated with the final reply
    expect(gateway.posts[0]!.threadTs).toBe("100.1");
    expect(gateway.updates.at(-1)!.text).toBe("Hello there!");
    expect(stateStore.get(STATE_KEYS.session("D1", "100.1"))).toBeTruthy();
    expect(stateStore.get(STATE_KEYS.sessionIndex)).toContain(STATE_KEYS.session("D1", "100.1"));
  });

  it("reuses the session for a reply in the same thread", async () => {
    const { ctx, chat } = setup();
    await chat.handleMessage(dm("hi", "100.1"));
    await chat.handleMessage(dm("again", "100.2", "100.1"));
    expect(ctx.agents.sessions.create).toHaveBeenCalledTimes(1);
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("ignores an unmentioned top-level channel message", async () => {
    const { ctx, chat } = setup();
    await chat.handleMessage({
      channel: "C1", channelType: "channel", user: "U1", text: "random chatter", ts: "1.1",
    });
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
  });

  it("ignores an unmentioned channel thread reply even when a session exists for the thread", async () => {
    const { ctx, gateway, chat, stateStore } = setup();
    stateStore.set(STATE_KEYS.session("C1", "50.1"), {
      sessionId: "sess-9", channel: "C1", threadTs: "50.1", lastActivityAt: new Date().toISOString(),
    });
    await chat.handleMessage({
      channel: "C1", channelType: "channel", user: "U1", text: "follow-up", ts: "50.2", threadTs: "50.1",
    });
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
    expect(gateway.posts).toHaveLength(0);
  });

  it("ignores an unmentioned reply in a bot-started thread — the reported regression", async () => {
    const { ctx, gateway, chat, stateStore } = setup();
    // The thread root is the bot's own proactive post. State holds a session
    // for it — however it got there; see the design doc's "Why the current
    // code allows it". After this change the channel path never reads it.
    stateStore.set(STATE_KEYS.session("C-FEED", "1000.1"), {
      sessionId: "sess-sweep", channel: "C-FEED", threadTs: "1000.1",
      lastActivityAt: new Date().toISOString(),
    });
    await chat.handleMessage({
      channel: "C-FEED", channelType: "group", user: "U-HUMAN",
      text: "there are currently only 80 Open Findings, not 83 - please re-check",
      ts: "1000.2", threadTs: "1000.1",
    });
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
    expect(gateway.posts).toHaveLength(0);
  });

  it("still answers an @mention inside a bot-started thread, reusing that thread's session", async () => {
    const { ctx, chat, stateStore } = setup();
    stateStore.set(STATE_KEYS.session("C-FEED", "1000.1"), {
      sessionId: "sess-sweep", channel: "C-FEED", threadTs: "1000.1",
      lastActivityAt: new Date().toISOString(),
    });
    await chat.handleMention({
      channel: "C-FEED", channelType: "channel", user: "U-HUMAN",
      text: "<@UBOT> please re-check the count", ts: "1000.3", threadTs: "1000.1",
    });
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledWith("sess-sweep", "co-1", expect.anything());
  });

  it("still converses on an unmentioned DM thread reply (proactive-DM replies keep working)", async () => {
    const { ctx, chat, stateStore } = setup();
    stateStore.set(STATE_KEYS.session("D1", "200.1"), {
      sessionId: "sess-dm", channel: "D1", threadTs: "200.1", lastActivityAt: new Date().toISOString(),
    });
    await chat.handleMessage(dm("thanks, got it", "200.2", "200.1"));
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledWith("sess-dm", "co-1", expect.anything());
  });

  it("skips messages containing the bot mention (handled by handleMention)", async () => {
    const { ctx, chat } = setup();
    await chat.handleMessage(dm("<@UBOT> hello", "9.1"));
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
  });

  it("strips the bot mention from mention prompts before framing", async () => {
    const { ctx, chat } = setup();
    await chat.handleMention({
      channel: "C1", channelType: "channel", user: "U1", text: "<@UBOT> help me", ts: "2.1",
    });
    const call = (ctx.agents.sessions.sendMessage as any).mock.calls[0];
    expect(call[2].prompt).toBe(buildChatPrompt(TEST_CONFIG.chatPromptPreamble, "help me"));
    expect(call[2].prompt).toContain("help me");
    expect(call[2].prompt).not.toContain("<@UBOT>");
  });

  it("posts an apology naming the reason when the session fails", async () => {
    const { ctx, gateway, chat } = setup();
    (ctx.agents.sessions.create as any).mockRejectedValueOnce(new Error("no agent"));
    await chat.handleMessage(dm("hi", "100.1"));
    const text = gateway.posts.at(-1)!.text;
    expect(text).toContain("something went wrong");
    // The reason must reach the person in the thread — see chat.ts.
    expect(text).toContain("no agent");
  });

  it("redacts tokens from the reason it posts to Slack", async () => {
    const { ctx, gateway, chat } = setup();
    (ctx.agents.sessions.create as any).mockRejectedValueOnce(
      new Error("bad auth xoxb-1234-secret"),
    );
    await chat.handleMessage(dm("hi", "101.1"));
    const text = gateway.posts.at(-1)!.text;
    expect(text).not.toContain("xoxb-1234-secret");
    expect(text).toContain("[REDACTED]");
  });

  it("posts an apology (and does not throw) when getConfig rejects", async () => {
    const bundle = makeCtx();
    const gateway = new FakeGateway();
    const chat = createChat({
      ctx: bundle.ctx,
      gateway,
      getConfig: () => Promise.reject(new Error("config store down")),
      updateIntervalMs: 0,
    });
    await expect(chat.handleMessage(dm("hi", "400.1"))).resolves.toBeUndefined();
    expect(gateway.posts.at(-1)!.text).toContain("something went wrong");
    expect(bundle.ctx.agents.sessions.create).not.toHaveBeenCalled();
  });

  it("clears the pending debounce timer when sendMessage rejects, so it can't overwrite the error message later", async () => {
    const bundle = makeCtx();
    const gateway = new FakeGateway();
    const chat = createChat({
      ctx: bundle.ctx,
      gateway,
      // Opt into streaming: this test is exercising the chunk-driven
      // debounce timer, which only schedules updates when enabled.
      getConfig: async () => ({ ...TEST_CONFIG, streamPartialReplies: true }),
      updateIntervalMs: 5,
    });
    (bundle.ctx.agents.sessions.sendMessage as any).mockImplementationOnce(
      async (_sessionId: string, _companyId: string, opts: { onEvent?: (e: unknown) => void }) => {
        // Schedule a debounced update from a buffered chunk, then fail the
        // outer call before that timer would fire.
        opts.onEvent?.({
          sessionId: "sess-1", runId: "run-1", seq: 1,
          eventType: "chunk", stream: "stdout", message: "stale partial buffer", payload: null,
        });
        throw new Error("network down");
      },
    );

    await chat.handleMessage(dm("hi", "500.1"));
    const updateCountAfterHandle = gateway.updates.length;
    expect(gateway.updates.at(-1)!.text).toContain("Failed to reach the agent");

    // Wait past the debounce interval to prove no leaked timer fires and
    // overwrites the error message with the stale buffered text.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(gateway.updates.length).toBe(updateCountAfterHandle);
    expect(gateway.updates.at(-1)!.text).toContain("Failed to reach the agent");
  });

  it("splits a long final reply: placeholder gets the first chunk, the remainder posts as additional thread messages", async () => {
    const { ctx, gateway, chat } = setup();
    const longText = "a".repeat(9000);
    (ctx.agents.sessions.sendMessage as any).mockImplementationOnce(
      async (_sessionId: string, _companyId: string, opts: { onEvent?: (e: unknown) => void }) => {
        opts.onEvent?.({
          sessionId: "sess-1", runId: "run-1", seq: 1,
          eventType: "done", stream: null, message: longText, payload: null,
        });
        return { runId: "run-1" };
      },
    );

    await chat.handleMessage(dm("hi", "800.1"));

    const placeholderTs = gateway.posts[0]!.ts;
    const placeholderUpdate = gateway.updates.find((u) => u.ts === placeholderTs);
    expect(placeholderUpdate!.text.length).toBe(3900);
    expect(placeholderUpdate!.text).toBe(longText.slice(0, 3900));

    const extraPosts = gateway.posts.slice(1);
    expect(extraPosts.length).toBe(2); // 9000 chars = 3900 + 3900 + 1200
    for (const post of extraPosts) expect(post.threadTs).toBe("800.1");

    const rejoined = placeholderUpdate!.text + extraPosts.map((p) => p.text).join("");
    expect(rejoined).toBe(longText);
  });

  it("escapes Slack control sequences in an agent's final reply", async () => {
    const { ctx, gateway, chat } = setup();
    (ctx.agents.sessions.sendMessage as any).mockImplementationOnce(
      async (_sessionId: string, _companyId: string, opts: { onEvent?: (e: unknown) => void }) => {
        opts.onEvent?.({
          sessionId: "sess-1", runId: "run-1", seq: 1,
          eventType: "done", stream: null, message: "<!channel> ship it", payload: null,
        });
        return { runId: "run-1" };
      },
    );

    await chat.handleMessage(dm("hi", "810.1"));

    // An agent must not be able to mass-ping a channel through a chat turn.
    expect(gateway.updates.at(-1)!.text).toBe("&lt;!channel&gt; ship it");
  });

  it("still renders an agent's own Markdown link in a chat reply", async () => {
    const { ctx, gateway, chat } = setup();
    (ctx.agents.sessions.sendMessage as any).mockImplementationOnce(
      async (_sessionId: string, _companyId: string, opts: { onEvent?: (e: unknown) => void }) => {
        opts.onEvent?.({
          sessionId: "sess-1", runId: "run-1", seq: 1,
          eventType: "done", stream: null, message: "see [the docs](https://ok.example)", payload: null,
        });
        return { runId: "run-1" };
      },
    );

    await chat.handleMessage(dm("hi", "811.1"));

    expect(gateway.updates.at(-1)!.text).toBe("see <https://ok.example|the docs>");
  });

  it("converts Markdown in the final agent reply to Slack mrkdwn before posting", async () => {
    const { ctx, gateway, chat } = setup();
    (ctx.agents.sessions.sendMessage as any).mockImplementationOnce(
      async (_sessionId: string, _companyId: string, opts: { onEvent?: (e: unknown) => void }) => {
        opts.onEvent?.({
          sessionId: "sess-1", runId: "run-1", seq: 1,
          eventType: "done", stream: null,
          message: "**bold** and [link](https://x.example)", payload: null,
        });
        return { runId: "run-1" };
      },
    );

    await chat.handleMessage(dm("hi", "900.1"));

    expect(gateway.updates.at(-1)!.text).toBe("*bold* and <https://x.example|link>");
  });

  it("creates only one session when two first messages race in the same thread", async () => {
    const { ctx, chat } = setup();
    await Promise.all([
      chat.handleMessage(dm("first", "700.1")),
      chat.handleMessage(dm("second", "700.2", "700.1")),
    ]);
    expect(ctx.agents.sessions.create).toHaveBeenCalledTimes(1);
  });

  describe("extractReply integration", () => {
    it("posts only the tagged reply when the done message contains narration before the tags", async () => {
      const { ctx, gateway, chat } = setup();
      const narration = "Let me think about this before I answer.\n\nOkay, here goes.";
      const answer = "Hey! What's up?";
      (ctx.agents.sessions.sendMessage as any).mockImplementationOnce(
        async (_sessionId: string, _companyId: string, opts: { onEvent?: (e: unknown) => void }) => {
          opts.onEvent?.({
            sessionId: "sess-1", runId: "run-1", seq: 1,
            eventType: "done", stream: null,
            message: `${narration}${REPLY_OPEN_TAG}${answer}${REPLY_CLOSE_TAG}`, payload: null,
          });
          return { runId: "run-1" };
        },
      );

      await chat.handleMessage(dm("sup", "1100.1"));

      expect(gateway.updates.at(-1)!.text).toBe(answer);
      expect(gateway.updates.at(-1)!.text).not.toContain(narration);
    });

    it("posts the full text unchanged when the done message has no tags (no regression)", async () => {
      const { ctx, gateway, chat } = setup();
      const fullText = "Just a plain reply, no tags involved at all.";
      (ctx.agents.sessions.sendMessage as any).mockImplementationOnce(
        async (_sessionId: string, _companyId: string, opts: { onEvent?: (e: unknown) => void }) => {
          opts.onEvent?.({
            sessionId: "sess-1", runId: "run-1", seq: 1,
            eventType: "done", stream: null, message: fullText, payload: null,
          });
          return { runId: "run-1" };
        },
      );

      await chat.handleMessage(dm("hi", "1100.2"));

      expect(gateway.updates.at(-1)!.text).toBe(fullText);
    });
  });

  describe("streamPartialReplies (default false)", () => {
    it("posts no chat.update for chunk events by default — only the final done reply is posted", async () => {
      const { gateway, chat } = setup();
      // The default sendMessage mock (see helpers.ts) emits a "Hello" chunk
      // event followed by a "Hello there!" done event.
      await chat.handleMessage(dm("hi", "150.1"));
      expect(gateway.updates.length).toBe(1);
      expect(gateway.updates[0]!.text).toBe("Hello there!");
    });

    it("falls back to the accumulated chunk buffer when done.message is null (unchanged from prior behavior)", async () => {
      const { ctx, gateway, chat } = setup();
      (ctx.agents.sessions.sendMessage as any).mockImplementationOnce(
        async (_sessionId: string, _companyId: string, opts: { onEvent?: (e: unknown) => void }) => {
          opts.onEvent?.({
            sessionId: "sess-1", runId: "run-1", seq: 1,
            eventType: "chunk", stream: "stdout", message: "partial-one ", payload: null,
          });
          opts.onEvent?.({
            sessionId: "sess-1", runId: "run-1", seq: 2,
            eventType: "chunk", stream: "stdout", message: "partial-two", payload: null,
          });
          opts.onEvent?.({
            sessionId: "sess-1", runId: "run-1", seq: 3,
            eventType: "done", stream: null, message: null, payload: null,
          });
          return { runId: "run-1" };
        },
      );

      await chat.handleMessage(dm("hi", "160.1"));

      // Still no intermediate chat.update pushed from the chunks — the
      // buffer is only surfaced once, as the done fallback.
      expect(gateway.updates.length).toBe(1);
      expect(gateway.updates[0]!.text).toBe("partial-one partial-two");
    });

    it("streams partial updates when opted in, filtering [paperclip] runtime-notice lines out of the streamed text", async () => {
      const { ctx, gateway, chat } = setup({ streamPartialReplies: true });
      (ctx.agents.sessions.sendMessage as any).mockImplementationOnce(
        async (_sessionId: string, _companyId: string, opts: { onEvent?: (e: unknown) => void }) => {
          opts.onEvent?.({
            sessionId: "sess-1", runId: "run-1", seq: 1,
            eventType: "chunk", stream: "stdout",
            message:
              '[paperclip] ACPX session "acpx:v2:abc" does not match the current agent/cwd/mode/runtime identity; starting fresh in "xyz"\nWorking on it now...',
            payload: null,
          });
          // Let the debounce timer fire before the done event arrives, so
          // an intermediate chat.update is actually observable.
          await new Promise((resolve) => setTimeout(resolve, 5));
          opts.onEvent?.({
            sessionId: "sess-1", runId: "run-1", seq: 2,
            eventType: "done", stream: null, message: "All done!", payload: null,
          });
          return { runId: "run-1" };
        },
      );

      await chat.handleMessage(dm("hi", "1000.1"));

      const intermediate = gateway.updates.find((u) => u.text.includes("Working on it now"));
      expect(intermediate).toBeTruthy();
      expect(intermediate!.text).not.toContain("[paperclip]");
      expect(gateway.updates.at(-1)!.text).toBe("All done!");
    });
  });
});

describe("buildChatPrompt", () => {
  it("with a preamble, returns the preamble, then the label, then the user text, in that order", () => {
    const result = buildChatPrompt("Be conversational.", "help me");
    const preambleIdx = result.indexOf("Be conversational.");
    const labelIdx = result.indexOf("Slack message:");
    const textIdx = result.indexOf("help me");
    expect(preambleIdx).toBeGreaterThanOrEqual(0);
    expect(labelIdx).toBeGreaterThan(preambleIdx);
    expect(textIdx).toBeGreaterThan(labelIdx);
  });

  it("with an empty preamble, returns exactly the user text", () => {
    expect(buildChatPrompt("", "help me")).toBe("help me");
  });

  it("with a whitespace-only preamble, returns exactly the user text", () => {
    expect(buildChatPrompt("   \n\t  ", "help me")).toBe("help me");
  });
});

describe("chatPromptPreamble (integration via createChat)", () => {
  it("with the default config, frames the prompt with the default preamble and the user's message", async () => {
    const { ctx, chat } = setup();
    await chat.handleMessage(dm("hi there", "300.1"));
    const call = (ctx.agents.sessions.sendMessage as any).mock.calls[0];
    expect(call[2].prompt).toContain(DEFAULT_CHAT_PROMPT_PREAMBLE);
    expect(call[2].prompt.startsWith(DEFAULT_CHAT_PROMPT_PREAMBLE)).toBe(true);
    expect(call[2].prompt).toContain("hi there");
  });

  it("with chatPromptPreamble set to empty string, sends the raw message verbatim", async () => {
    const { ctx, chat } = setup({ chatPromptPreamble: "" });
    await chat.handleMessage(dm("hi there", "301.1"));
    const call = (ctx.agents.sessions.sendMessage as any).mock.calls[0];
    expect(call[2].prompt).toBe("hi there");
  });
});

describe("filterRuntimeNoticeLines", () => {
  it("drops [paperclip] runtime-notice lines and keeps everything else, including indented notices", () => {
    const input = [
      '[paperclip] ACPX session "acpx:v2:foo" does not match the current agent/cwd/mode/runtime identity; starting fresh in "bar"',
      "Actual reply line one",
      "  [paperclip] indented notice too",
      "Actual reply line two",
    ].join("\n");
    expect(filterRuntimeNoticeLines(input)).toBe(
      ["Actual reply line one", "Actual reply line two"].join("\n"),
    );
  });

  it("leaves text with no runtime-notice lines unchanged", () => {
    const input = "Just a normal reply\nwith multiple lines";
    expect(filterRuntimeNoticeLines(input)).toBe(input);
  });

  it("does not touch lines that merely mention [paperclip] mid-line", () => {
    const input = "This is about the [paperclip] plugin, not a runtime notice";
    expect(filterRuntimeNoticeLines(input)).toBe(input);
  });
});

describe("extractReply", () => {
  it("returns the content of a single tag pair, trimmed", () => {
    expect(extractReply(`${REPLY_OPEN_TAG}Hey there!${REPLY_CLOSE_TAG}`)).toBe("Hey there!");
    expect(extractReply(`  ${REPLY_OPEN_TAG}  Hey there!  ${REPLY_CLOSE_TAG}  `)).toBe("Hey there!");
  });

  it("preserves newlines and markdown inside the tagged content", () => {
    const inner = "Here's a list:\n- one\n- two\n\n**bold** and a [link](https://x.example)";
    expect(extractReply(`${REPLY_OPEN_TAG}${inner}${REPLY_CLOSE_TAG}`)).toBe(inner);
  });

  it("when the model echoes the instruction (two pairs), the last pair wins", () => {
    const input =
      `The instructions said to wrap my reply like ${REPLY_OPEN_TAG}this${REPLY_CLOSE_TAG}, got it.\n\n` +
      `${REPLY_OPEN_TAG}Hey! What's up?${REPLY_CLOSE_TAG}`;
    expect(extractReply(input)).toBe("Hey! What's up?");
  });

  it("with an unclosed opening tag, returns everything after the last opening tag", () => {
    const input = `Some narration first.\n${REPLY_OPEN_TAG}\nHey there, the actual reply.`;
    expect(extractReply(input)).toBe("Hey there, the actual reply.");
  });

  it("with no tags at all, returns the input unchanged (trimmed)", () => {
    expect(extractReply("Just a plain reply, no tags.")).toBe("Just a plain reply, no tags.");
    expect(extractReply("  padded plain reply  ")).toBe("padded plain reply");
  });

  it("falls back to the input when the tagged content is empty after trimming", () => {
    const input = `Narration outside the tags.${REPLY_OPEN_TAG}   ${REPLY_CLOSE_TAG}`;
    expect(extractReply(input)).toBe(input.trim());
  });

  it("extracts exactly the wrapped sentence from the real observed narrate-then-answer output", () => {
    const narration =
      'Let me understand the context:\n\n' +
      "1. I'm a Paperclip agent (Chief of staff for Noditos)\n" +
      '2. I received a wake from a Slack chat message that just says "sup"\n' +
      '...\n' +
      'The key instruction is: "You are replying to a person in a Slack thread..."\n\n' +
      'So I should just respond to "sup" in a natural, conversational way.';
    const answer = "Hey! What's up? How can I help you today";
    const input = `${narration}${REPLY_OPEN_TAG}${answer}${REPLY_CLOSE_TAG}`;
    expect(extractReply(input)).toBe(answer);
  });
});

describe("wake reason", () => {
  it("tells the agent this is a Slack chat turn rather than waking it with no reason", async () => {
    const bundle = makeCtx();
    const gateway = new FakeGateway();
    const chat = createChat({
      ctx: bundle.ctx,
      gateway,
      getConfig: async () => ({ ...TEST_CONFIG }),
      updateIntervalMs: 0,
    });
    await chat.handleMessage({
      channel: "D1", channelType: "im", user: "U1", text: "sup", ts: "900.1",
    });
    const call = (bundle.ctx.agents.sessions.sendMessage as any).mock.calls[0];
    expect(call[2].reason).toBe("slack_chat_message");
  });
});
