import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function readDoc(name: string): string {
  return readFileSync(resolve(root, name), "utf8");
}

describe("SECURITY.md", () => {
  const content = readDoc("SECURITY.md");
  const lines = content.split("\n");

  it("exists and is non-empty", () => {
    expect(content.length).toBeGreaterThan(0);
  });

  it("is at most 100 lines", () => {
    expect(lines.length).toBeLessThanOrEqual(100);
  });

  it("covers API key policy (environment variable only)", () => {
    expect(content.toLowerCase()).toMatch(/environment variable/i);
    expect(content.toLowerCase()).toMatch(/api key/i);
  });

  it("prohibits API keys in source code", () => {
    expect(content).toMatch(/never/i);
    expect(content.toLowerCase()).toMatch(/source/i);
  });

  it("covers session token storage policy", () => {
    expect(content.toLowerCase()).toMatch(/session token/i);
    expect(content.toLowerCase()).toMatch(/localstorage/i);
  });

  it("recommends in-memory or short-lived cookie for session tokens", () => {
    expect(content.toLowerCase()).toMatch(/in.memory|in memory/i);
    expect(content.toLowerCase()).toMatch(/cookie/i);
  });

  it("provides a vulnerability reporting email address", () => {
    expect(content).toMatch(/[a-z.]+@[a-z.]+/i);
  });

  it("states an expected response time for vulnerability reports", () => {
    expect(content).toMatch(/\d+\s*(business\s*)?day/i);
  });

  it("mentions coordinated disclosure", () => {
    expect(content.toLowerCase()).toMatch(/coordinated disclosure/i);
  });

  it("contains no internal ticket references (ost-*)", () => {
    expect(content).not.toMatch(/ost-/i);
  });

  it("contains no internal wiki paths (.agents/)", () => {
    expect(content).not.toMatch(/\.agents\//);
  });
});

describe("CONTRIBUTING.md", () => {
  const content = readDoc("CONTRIBUTING.md");
  const lines = content.split("\n");

  it("exists and is non-empty", () => {
    expect(content.length).toBeGreaterThan(0);
  });

  it("is at most 100 lines", () => {
    expect(lines.length).toBeLessThanOrEqual(100);
  });

  it("documents conventional commit types", () => {
    // Must mention at least feat, fix, and docs
    expect(content).toMatch(/\bfeat\b/);
    expect(content).toMatch(/\bfix\b/);
    expect(content).toMatch(/\bdocs\b/);
  });

  it("describes branch and PR flow against main", () => {
    expect(content.toLowerCase()).toMatch(/\bmain\b/);
    expect(content.toLowerCase()).toMatch(/pull request|pr/i);
  });

  it("requires green CI before merge", () => {
    expect(content.toLowerCase()).toMatch(/ci|check/i);
    expect(content.toLowerCase()).toMatch(/pass|green/i);
  });

  it("requires new tests for new features", () => {
    expect(content.toLowerCase()).toMatch(/new feature/i);
    expect(content.toLowerCase()).toMatch(/test/i);
  });

  it("requires regression tests for bug fixes", () => {
    expect(content.toLowerCase()).toMatch(/bug fix|regression/i);
    expect(content.toLowerCase()).toMatch(/test/i);
  });

  it("states existing tests must pass for refactors", () => {
    expect(content.toLowerCase()).toMatch(/refactor/i);
    expect(content.toLowerCase()).toMatch(/existing test/i);
  });

  it("contains no internal ticket references (ost-*)", () => {
    expect(content).not.toMatch(/ost-/i);
  });

  it("contains no internal wiki paths (.agents/)", () => {
    expect(content).not.toMatch(/\.agents\//);
  });
});
