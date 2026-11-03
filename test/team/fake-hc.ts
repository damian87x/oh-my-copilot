import type { HcResult, HcRunner } from "../../src/team/herdr.js";

/**
 * Stateful in-memory herdr-core (`hc`) fake for unit tests. Models live/finished
 * terminals, unique live names, kill/rm, and a ready Copilot screen.
 */
export interface FakeHc {
  runner: HcRunner;
  calls: string[][];
  terminals: Map<string, { name?: string; state: "live" | "finished" }>;
  sends: { target: string; text: string }[];
  down: boolean;
}

const ok = (stdout = ""): HcResult => ({ stdout, stderr: "", status: 0 });
const fail = (kind: string, status = 1): HcResult => ({
  stdout: "",
  stderr: JSON.stringify({ error: { kind, message: kind } }),
  status,
});

export function makeFakeHc(screen = "❯\n / commands · ? help\n"): FakeHc {
  let next = 0;
  const fake: FakeHc = {
    calls: [],
    terminals: new Map(),
    sends: [],
    down: false,
    runner: (args) => {
      fake.calls.push(args);
      if (fake.down) return { stdout: "", stderr: "connect failed", status: 1 };
      const [cmd, target] = args;
      const t = target ? fake.terminals.get(target) : undefined;
      switch (cmd) {
        case "server":
          return ok("{}");
        case "run": {
          const name = args[args.indexOf("--name") + 1];
          for (const term of fake.terminals.values()) {
            if (term.state === "live" && term.name === name) return fail("name_taken");
          }
          const address = `t${++next}`;
          fake.terminals.set(address, { name, state: "live" });
          return ok(JSON.stringify({ address, name, state: "live" }));
        }
        case "get":
          return t ? ok(JSON.stringify({ address: target, state: t.state })) : fail("not_found", 3);
        case "ls":
          return ok(
            JSON.stringify({
              terminals: [...fake.terminals.entries()]
                .filter(([, v]) => v.state === "live")
                .map(([address, v]) => ({ address, name: v.name, state: v.state })),
            }),
          );
        case "kill":
          if (!t) return fail("not_found", 3);
          t.state = "finished";
          return ok("{}");
        case "rm":
          if (!t) return fail("not_found", 3);
          fake.terminals.delete(target!);
          return ok("{}");
        case "read":
          return t ? ok(screen) : fail("not_found", 3);
        case "send":
          if (!t) return fail("not_found", 3);
          fake.sends.push({ target: target!, text: args[2]! });
          return ok("{}");
        case "keys":
          return t ? ok("{}") : fail("not_found", 3);
        default:
          return fail("unknown_command", 2);
      }
    },
  };
  return fake;
}
