import "./host-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SURFACE_PLACEMENT,
  parseSurfacePlacement,
} from "../src/placement.ts";

test("parses the three placements", () => {
  assert.equal(parseSurfacePlacement("right"), "right");
  assert.equal(parseSurfacePlacement("down"), "down");
  assert.equal(parseSurfacePlacement("tab"), "tab");
});

test("rejects everything else, including the pmux placements", () => {
  assert.equal(parseSurfacePlacement("pane"), undefined);
  assert.equal(parseSurfacePlacement("float"), undefined);
  assert.equal(parseSurfacePlacement(""), undefined);
  assert.equal(parseSurfacePlacement(undefined), undefined);
  assert.equal(parseSurfacePlacement(7), undefined);
});

test("the default placement is a side-by-side split", () => {
  assert.equal(DEFAULT_SURFACE_PLACEMENT, "right");
});
