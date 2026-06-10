import { describe, expect, it } from "vitest";
import { shq, redactSecrets, lastLines, parseComposePs, daysUntil } from "../src/util.js";

describe("shq", () => {
  it("quotes plain strings", () => {
    expect(shq("abc")).toBe("'abc'");
  });
  it("escapes single quotes", () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });
});

describe("redactSecrets", () => {
  it("redacts env-style credentials but keeps keys visible", () => {
    const input = [
      "POSTGRES_PASSWORD=supersecret123",
      "SESSION_SECRET=abc",
      "SERVER_API_KEY=demo_server_key",
      "ADMIN_EMAIL=me@example.com",
      "   Password: hunter2",
    ].join("\n");
    const out = redactSecrets(input);
    expect(out).not.toContain("supersecret123");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("POSTGRES_PASSWORD=[redacted]");
    expect(out).toContain("SERVER_API_KEY=[redacted]");
    expect(out).toContain("ADMIN_EMAIL=me@example.com"); // not a credential
  });
});

describe("lastLines", () => {
  it("passes short output through", () => {
    expect(lastLines("a\nb", 5)).toBe("a\nb");
  });
  it("truncates long output with a marker", () => {
    const out = lastLines(Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n"), 3);
    expect(out).toContain("7 earlier lines omitted");
    expect(out).toContain("l9");
    expect(out).not.toContain("l5\n");
  });
});

describe("parseComposePs", () => {
  const row = { Name: "adanalytics-api-1", Service: "api", State: "running", Status: "Up 2 hours (healthy)", Health: "healthy" };
  it("parses JSON-lines output (compose v2.21+)", () => {
    const out = parseComposePs(JSON.stringify(row) + "\n" + JSON.stringify({ ...row, Service: "web" }));
    expect(out).toHaveLength(2);
    expect(out[1].Service).toBe("web");
  });
  it("parses single-array output (older compose)", () => {
    expect(parseComposePs(JSON.stringify([row]))).toHaveLength(1);
  });
  it("returns empty on garbage", () => {
    expect(parseComposePs("")).toHaveLength(0);
    expect(parseComposePs("not json")).toHaveLength(0);
  });
});

describe("daysUntil", () => {
  it("computes whole days", () => {
    const now = Date.parse("2026-06-10T00:00:00Z");
    expect(daysUntil(Date.parse("2026-07-10T00:00:00Z"), now)).toBe(30);
    expect(daysUntil(Date.parse("2026-06-09T00:00:00Z"), now)).toBe(-1);
  });
});
