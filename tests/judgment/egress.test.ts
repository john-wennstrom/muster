import { describe, expect, test } from "bun:test";
import type { JudgmentQuestions } from "../../src/judgment/client.ts";
import {
  JUDGMENT_QUESTION_TOKEN_LIMIT,
  JUDGMENT_REQUEST_TOKEN_LIMIT,
  deniedPaths,
  estimateTokens,
  prepareEgress,
  redactState,
  redactString,
} from "../../src/judgment/egress.ts";

const question = (text = "Is it so?"): JudgmentQuestions[string] => ({
  type: "noul",
  instructions: text,
});

describe("redaction", () => {
  test.each([
    ["bearer credential in an authorization header", "Authorization: Bearer abc123.def456", "abc123.def456"],
    ["bare bearer credential", "curl -H 'x: y' failed with Bearer eyJhbGciOiJIUzI1NiJ9.payload", "eyJhbGciOiJIUzI1NiJ9"],
    ["token flag", "gh run --token ghp_supersecret123 --verbose", "ghp_supersecret123"],
    ["password flag with equals", "cli --password=hunter2 go", "hunter2"],
    ["quoted api key flag", "cli --api-key 'sk test 99' go", "sk test 99"],
    ["key colon value", "api_key: sk-live-000111", "sk-live-000111"],
    ["prefixed secret name", "client_secret = zzz-secret-value", "zzz-secret-value"],
    ["npm auth token", "//registry.npmjs.org/:_authToken=npm_abcdefgh", "npm_abcdefgh"],
    ["json embedded secret", '{"password": "correct horse"}', "correct horse"],
    ["url query secret", "GET https://x.test/cb?access_token=tok123&page=2", "tok123"],
    ["url userinfo", "git clone https://bot:s3cr3tpw@github.com/x/y", "s3cr3tpw"],
    [
      "private key block",
      "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----\nafter",
      "MIIabc",
    ],
    ["truncated private key block", "-----BEGIN PRIVATE KEY-----\nMIIabc-truncated", "MIIabc-truncated"],
  ])("redacts %s", (_name, input, secret) => {
    const output = redactString(input);
    expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED]");
  });

  test("keeps surrounding text and unrelated content intact", () => {
    expect(redactString("max_tokens: 4096 and token counts stay")).toBe("max_tokens: 4096 and token counts stay");
    expect(redactString("keep\n  whitespace\tas is")).toBe("keep\n  whitespace\tas is");
    expect(redactString("--token abc --verbose")).toBe("--token [REDACTED] --verbose");
    expect(redactString("https://x.test/cb?page=2&token=zz")).toBe("https://x.test/cb?page=2&token=[REDACTED]");
  });

  test("redacts exact secret values wherever they appear", () => {
    expect(redactString("value sk-exact-key inside", ["sk-exact-key"])).toBe("value [REDACTED] inside");
  });

  test("redacts every string in a nested state and secret-named keys", () => {
    const state = {
      failure: "Authorization: Bearer abc123.def456",
      list: ["--token xyz-123-secret", { deep: "password: p4ss" }],
      config: { password: "hunter2", count: 3, flag: true, none: null },
    };
    const output = JSON.stringify(redactState(state));

    for (const secret of ["abc123.def456", "xyz-123-secret", "p4ss", "hunter2"]) {
      expect(output).not.toContain(secret);
    }
    expect(redactState(state)).toMatchObject({ config: { count: 3, flag: true, none: null } });
  });
});

describe("credential denylist", () => {
  test.each([
    [".env", "environment"],
    ["apps/web/.env.local", "environment"],
    ["config/prod.env", "environment"],
    ["certs/server.pem", "private_key"],
    ["deploy/tls.key", "private_key"],
    ["ca.crt", "private_key"],
    ["home/.ssh/id_ed25519", "private_key"],
    [".npmrc", "registry_auth"],
    ["pkg/.pypirc", "registry_auth"],
    [".netrc", "registry_auth"],
    [".aws/credentials", "cloud_credentials"],
    [".config/gcloud/application_default_credentials.json", "cloud_credentials"],
    [".git-credentials", "cloud_credentials"],
    [".kube/config", "cloud_credentials"],
    ["infra\\.AWS\\Credentials", "cloud_credentials"],
    ["./.ENV", "environment"],
  ] as const)("denies %s", (path, family) => {
    expect(deniedPaths([path])).toEqual([{ path, family }]);
  });

  test.each([
    "src/index.ts",
    "openspec/changes/x/design.md",
    "docs/security.md",
    "README.md",
    "src/environment.ts",
    "tests/fixtures/keyboard.test.ts",
    "package.json",
  ])("allows %s", (path) => {
    expect(deniedPaths([path])).toEqual([]);
  });

  test("names every denied path among allowed ones", () => {
    expect(deniedPaths(["src/a.ts", ".env", "src/b.ts", "server.pem"]).map(({ path }) => path))
      .toEqual([".env", "server.pem"]);
  });
});

describe("egress preparation", () => {
  test("refuses a state that draws on a credential file and sends nothing", () => {
    const result = prepareEgress({
      state: "content",
      questions: { q: question() },
      sourcePaths: ["src/a.ts", ".env.production"],
    });
    expect(result).toMatchObject({ ok: false, reason: "state_denied" });
    expect(result.ok === false && result.detail).toContain(".env.production");
  });

  test("allows a state drawn from ordinary source paths", () => {
    const result = prepareEgress({
      state: { file: "export const a = 1;" },
      questions: { q: question() },
      sourcePaths: ["src/a.ts", "docs/security.md"],
    });
    expect(result.ok).toBe(true);
  });

  test("redacts the state and the api key before it can be sent", () => {
    const result = prepareEgress({
      state: { log: "Authorization: Bearer abc123.def456 and sk-key-in-log" },
      questions: { q: question() },
      secretValues: ["sk-key-in-log"],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.stateText).not.toContain("abc123.def456");
    expect(result.stateText).not.toContain("sk-key-in-log");
  });

  test("estimates conservatively", () => {
    expect(estimateTokens("abcd")).toBeGreaterThanOrEqual(1);
    expect(estimateTokens("a".repeat(300))).toBeGreaterThanOrEqual(100);
    expect(estimateTokens("é".repeat(10))).toBe(estimateTokens("aaaaaaaaaaaaaaaaaaaa"));
  });

  test("refuses a state too large for the longest question", () => {
    const state = "x".repeat(JUDGMENT_QUESTION_TOKEN_LIMIT * 3 + 300);
    const result = prepareEgress({ state, questions: { q: question() } });
    expect(result).toMatchObject({ ok: false, reason: "state_too_large" });
  });

  test("refuses a state too large for all questions", () => {
    const perQuestion = question("y".repeat(3_000));
    const questions = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`q${index}`, perQuestion]),
    );
    // About 20k state tokens: within the 32k bound with one question, over 64k with fifty.
    const state = "x".repeat(20_000 * 3);
    const many = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [`q${index}`, perQuestion]),
    );
    expect(prepareEgress({ state, questions })).toMatchObject({ ok: true });
    const result = prepareEgress({ state, questions: many });
    expect(result).toMatchObject({ ok: false, reason: "state_too_large" });
    expect(result.ok === false && result.detail).toContain(String(JUDGMENT_REQUEST_TOKEN_LIMIT));
  });

  test("sends a state within limits exactly as supplied, never truncated", () => {
    const state = "line one\n" + "z".repeat(30_000 * 3 - 1_000);
    const result = prepareEgress({ state, questions: { q: question() } });
    if (!result.ok) throw new Error("expected ok");
    expect(result.state).toBe(state);
    expect(result.stateText).toBe(state);
  });
});
