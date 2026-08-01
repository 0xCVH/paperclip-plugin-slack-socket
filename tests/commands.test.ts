import { describe, expect, it } from "vitest";
import { createCommands } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import { FakeGateway, makeCtx } from "./helpers.js";

function setup() {
  const bundle = makeCtx();
  const gateway = new FakeGateway();
  const commands = createCommands({ ctx: bundle.ctx, gateway, getConfig: () => loadConfig(bundle.ctx) });
  return { ...bundle, gateway, commands };
}

const cmd = (text: string) => ({ command: "/paperclip", text, user: "U1", channel: "C1" });

describe("commands", () => {
  it("creates an issue and replies ephemerally with a link", async () => {
    const { ctx, gateway, commands } = setup();
    await commands.handleCommand(cmd("issue Fix the login flow"));
    expect(ctx.issues.create).toHaveBeenCalledWith({
      companyId: "co-1", title: "Fix the login flow", status: "todo",
    });
    expect(gateway.ephemerals[0]!.text).toContain("https://pc.example/issues/issue-1");
  });

  it("shows usage when the title is missing", async () => {
    const { ctx, gateway, commands } = setup();
    await commands.handleCommand(cmd("issue"));
    expect(ctx.issues.create).not.toHaveBeenCalled();
    expect(gateway.ephemerals[0]!.text).toContain("Usage");
  });

  it("replies with help for anything else", async () => {
    const { gateway, commands } = setup();
    await commands.handleCommand(cmd("help"));
    expect(gateway.ephemerals[0]!.text).toContain("/paperclip issue");
  });

  it("reports failure ephemerally when issue creation throws", async () => {
    const { ctx, gateway, commands } = setup();
    (ctx.issues.create as any).mockRejectedValueOnce(new Error("nope"));
    await commands.handleCommand(cmd("issue X"));
    expect(gateway.ephemerals[0]!.text).toContain("Failed");
  });
});
