import "./host-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeChildEnv,
  encodeChildEnv,
  isSubagentChild,
  type ChildEnv,
} from "../src/child-env.ts";

test("round-trips a full ChildEnv", () => {
  const full: ChildEnv = {
    name: "child",
    agent: "scout",
    sessionFile: "/tmp/s.jsonl",
    id: "id-1",
    activityFile: "/tmp/a.json",
    surface: "%24",
    autoExit: true,
    denyTools: ["claude"],
  };
  assert.deepEqual(decodeChildEnv(encodeChildEnv(full)), full);
});

test("round-trips a minimal ChildEnv", () => {
  const minimal: ChildEnv = { autoExit: false, denyTools: [] };
  const decoded = decodeChildEnv(encodeChildEnv(minimal));
  assert.equal(decoded.autoExit, false);
  assert.deepEqual(decoded.denyTools, []);
  assert.equal(decoded.name, undefined);
  assert.equal(decoded.sessionFile, undefined);
});

test("encodeChildEnv leaves out an empty deny list and autoExit false", () => {
  assert.deepEqual(encodeChildEnv({ autoExit: false, denyTools: [] }), {});
});

test("decodeChildEnv treats an empty string as not set", () => {
  const env = decodeChildEnv({ PI_FOREMAN_NAME: "", PI_FOREMAN_SESSION: "" });
  assert.equal(env.name, undefined);
  assert.equal(env.sessionFile, undefined);
});

test("isSubagentChild is true exactly when a session file is set", () => {
  assert.equal(isSubagentChild({ PI_FOREMAN_SESSION: "/s.jsonl" }), true);
  assert.equal(isSubagentChild({ PI_FOREMAN_NAME: "x" }), false);
  assert.equal(isSubagentChild({}), false);
});

test("decodeChildEnv trims and drops empty deny entries", () => {
  const env = decodeChildEnv({ PI_DENY_TOOLS: " claude, ,bash ," });
  assert.deepEqual(env.denyTools, ["claude", "bash"]);
});
