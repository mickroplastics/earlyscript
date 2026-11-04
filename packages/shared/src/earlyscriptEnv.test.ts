import { assert, describe, it } from "vite-plus/test";

import {
  adoptEarlyscriptEnvironment,
  earlyscriptAliasOf,
  earlyscriptChildEnvironment,
  mirrorToEarlyscriptEnvironment,
} from "./earlyscriptEnv.ts";

/** What a terminal or agent started by T3 Code inherits on this machine. */
const fromT3Code = (): NodeJS.ProcessEnv => ({
  PATH: "/usr/bin",
  HOME: "/home/miguel",
  T3CODE_HOME: "/home/miguel/.t3",
  T3CODE_THREAD_ID: "thread:delegated-task:abc",
  T3CODE_PORT: "3773",
  T3CODE_CLI_PATH: "/home/miguel/.local/bin/t3",
  T3_BOOT_SERVICE_UNIT: "t3code.service",
  T3_SERVICE_LAUNCHER_CONTEXT: '{"dbPath":"/home/miguel/.t3/userdata/statev2.sqlite"}',
  T3CODE_PORT_OFFSET: "60",
  T3CODE_DEV_SEED: "0",
  ELECTRON_RUN_AS_NODE: "1",
});

describe("adoptEarlyscriptEnvironment", () => {
  it("drops every inherited T3 variable in the installed app", () => {
    const env = fromT3Code();
    const dropped = adoptEarlyscriptEnvironment(env, {
      transitional: false,
      dropElectronRunAsNode: true,
    });
    assert.deepStrictEqual(env, { PATH: "/usr/bin", HOME: "/home/miguel" });
    assert.includeMembers(
      [...dropped],
      ["T3CODE_HOME", "T3_BOOT_SERVICE_UNIT", "ELECTRON_RUN_AS_NODE"],
    );
  });

  it("keeps the dev-runner knobs during the transition, and ELECTRON_RUN_AS_NODE for the server", () => {
    const env = fromT3Code();
    adoptEarlyscriptEnvironment(env, { transitional: true, dropElectronRunAsNode: false });
    assert.deepStrictEqual(env, {
      PATH: "/usr/bin",
      HOME: "/home/miguel",
      T3CODE_PORT_OFFSET: "60",
      T3CODE_DEV_SEED: "0",
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  it("reads EARLYSCRIPT_* back under the names upstream code reads", () => {
    const env: NodeJS.ProcessEnv = {
      ...fromT3Code(),
      EARLYSCRIPT_HOME: "/home/miguel/earlyscript-data/isolation/home",
      EARLYSCRIPT_PORT_OFFSET: "61",
      EARLYSCRIPT_CLI_PATH: "/opt/earlyscript/bin/earlyscript",
      EARLYSCRIPT_FLAG_TERMINAL: "1",
      EARLYSCRIPT_EDITORIAL_RUNS_DIR: "/runs",
      EARLYSCRIPT_THREAD_ID: "thread-1",
      EARLYSCRIPT_DESKTOP_CLI_LAUNCHER: "1",
    };
    adoptEarlyscriptEnvironment(env, { transitional: true, dropElectronRunAsNode: true });
    assert.equal(env.T3CODE_HOME, "/home/miguel/earlyscript-data/isolation/home");
    assert.equal(env.T3CODE_PORT_OFFSET, "61");
    assert.equal(env.T3CODE_CLI_PATH, "/opt/earlyscript/bin/earlyscript");
    assert.isUndefined(env.T3CODE_THREAD_ID);
    assert.isUndefined(env.T3CODE_FLAG_TERMINAL);
    assert.isUndefined(env.T3CODE_EDITORIAL_RUNS_DIR);
    assert.equal(env.EARLYSCRIPT_FLAG_TERMINAL, "1");
    // One-shot marker: this process reads it, children do not inherit it.
    assert.equal(env.T3CODE_DESKTOP_CLI_LAUNCHER, "1");
    assert.isUndefined(env.EARLYSCRIPT_DESKTOP_CLI_LAUNCHER);
  });
});

describe("mirrorToEarlyscriptEnvironment", () => {
  it("makes a child read back exactly the parent's settings", () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      EARLYSCRIPT_HOME: "/stale",
      EARLYSCRIPT_MODE: "web",
    };
    adoptEarlyscriptEnvironment(parent, { transitional: true, dropElectronRunAsNode: true });
    const child: NodeJS.ProcessEnv = { ...parent, T3CODE_HOME: "/repo/.t3", T3CODE_PORT: "14833" };
    delete child.T3CODE_MODE;
    mirrorToEarlyscriptEnvironment(child);
    assert.equal(child.EARLYSCRIPT_HOME, "/repo/.t3");
    assert.equal(child.EARLYSCRIPT_PORT, "14833");
    assert.isUndefined(child.EARLYSCRIPT_MODE);

    const inChild: NodeJS.ProcessEnv = { ...child, T3CODE_HOME: "/home/miguel/.t3" };
    adoptEarlyscriptEnvironment(inChild, { transitional: true, dropElectronRunAsNode: false });
    assert.equal(inChild.T3CODE_HOME, "/repo/.t3");
    assert.equal(inChild.T3CODE_PORT, "14833");
    assert.isUndefined(inChild.T3CODE_MODE);
  });

  it("names the alias of a T3 setting", () => {
    assert.equal(earlyscriptAliasOf("T3CODE_PORT"), "EARLYSCRIPT_PORT");
  });
});

describe("earlyscriptChildEnvironment", () => {
  /** The server's own environment once adopted: its aliases and transitional knobs. */
  const serverEnvironment = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
      ...fromT3Code(),
      EARLYSCRIPT_HOME: "/home/miguel/earlyscript-data/isolation/home2",
      EARLYSCRIPT_CLI_PATH: "/opt/earlyscript/bin/earlyscript",
      EARLYSCRIPT_PORT: "14842",
      EARLYSCRIPT_NO_BROWSER: "1",
      EARLYSCRIPT_FLAG_TERMINAL: "1",
      EARLYSCRIPT_THREAD_ID: "thread-parent",
    };
    adoptEarlyscriptEnvironment(env, { transitional: true, dropElectronRunAsNode: false });
    return env;
  };

  it("keeps no T3CODE_* or T3_* of the server, and only the home and launcher of its aliases", () => {
    const server = serverEnvironment();
    assert.equal(server.T3CODE_HOME, "/home/miguel/earlyscript-data/isolation/home2");
    const child = earlyscriptChildEnvironment({ ...server }, server);
    assert.deepStrictEqual(
      Object.keys(child).filter((name) => /^(T3CODE_|T3_)/u.test(name)),
      [],
    );
    assert.deepStrictEqual(child, {
      PATH: "/usr/bin",
      HOME: "/home/miguel",
      ELECTRON_RUN_AS_NODE: "1",
      EARLYSCRIPT_HOME: "/home/miguel/earlyscript-data/isolation/home2",
      EARLYSCRIPT_CLI_PATH: "/opt/earlyscript/bin/earlyscript",
      EARLYSCRIPT_FLAG_TERMINAL: "1",
      EARLYSCRIPT_THREAD_ID: "thread-parent",
    });
  });

  it("keeps what the caller set for this child: its MCP wiring and project-script contract", () => {
    const server = serverEnvironment();
    const child: NodeJS.ProcessEnv = earlyscriptChildEnvironment(
      {
        ...server,
        T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:14842/mcp/session-1",
        T3_ACP_MCP_AUTHORIZATION: "Bearer x",
        T3_MCP_URL: "http://127.0.0.1:14842/mcp",
        T3CODE_PROJECT_ROOT: "/repo",
        EARLYSCRIPT_THREAD_ID: "thread-child",
        ELECTRON_RUN_AS_NODE: "1",
      },
      server,
    );
    assert.equal(child.T3_ACP_MCP_ENDPOINT, "http://127.0.0.1:14842/mcp/session-1");
    assert.equal(child.T3_ACP_MCP_AUTHORIZATION, "Bearer x");
    assert.equal(child.T3_MCP_URL, "http://127.0.0.1:14842/mcp");
    assert.equal(child.T3CODE_PROJECT_ROOT, "/repo");
    assert.equal(child.EARLYSCRIPT_THREAD_ID, "thread-child");
    assert.equal(child.ELECTRON_RUN_AS_NODE, "1");
    assert.isUndefined(child.T3CODE_HOME);
    assert.isUndefined(child.T3CODE_PORT_OFFSET);
  });

  it("lets an Earlyscript started from that child read EARLYSCRIPT_HOME and nothing of T3", () => {
    const server = serverEnvironment();
    // A terminal of the server, where a user or agent runs `earlyscript`.
    const inChild = earlyscriptChildEnvironment({ ...server }, server);
    adoptEarlyscriptEnvironment(inChild, { transitional: false, dropElectronRunAsNode: false });
    assert.equal(inChild.T3CODE_HOME, "/home/miguel/earlyscript-data/isolation/home2");
    assert.isUndefined(inChild.T3CODE_PORT);
    assert.isUndefined(inChild.T3CODE_THREAD_ID);
  });
});
