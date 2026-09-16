import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasOpenSpecConfig, parseTaskPlan, resolveArtifact } from "../modules/openspec-workflow.ts";

describe("OpenSpec workflow parsing", () => {
	test("parses ordered phases, checkbox state, and verification metadata", () => {
		const phases = parseTaskPlan(`# Implementation Plan\n\n## Phase 1 — Foundation\n\n- [x] 1.1 Add storage\n  - Requirement: Persistence\n  - Verify: Scenario "Stores entity"\n  - Verify command: \`bun test storage\`\n\n## Phase 2 — Integration\n\n- [ ] 2.1 Wire API`);
		expect(phases.map((phase) => phase.number)).toEqual([1, 2]);
		expect(phases[0].tasks[0]).toMatchObject({ id: "1.1", checked: true, requirements: ["Persistence"], scenarios: ["Stores entity"], verifyCommands: ["bun test storage"] });
		expect(phases[1].tasks[0]).toMatchObject({ id: "2.1", checked: false, phaseTitle: "Integration" });
	});

	test("always writes artifacts inside the OpenSpec change directory", () => {
		const artifact = resolveArtifact({ contextFiles: { design: { outputPath: "custom/design.md" } } }, "design", "/tmp/project", "example");
		expect(artifact.path).toBe("/tmp/project/openspec/changes/example/design.md");
		expect(artifact.contextFiles).toContain("/tmp/project/custom/design.md");
	});

	test("detects an initialized project by its openspec config file", () => {
		const project = mkdtempSync(join(tmpdir(), "openspec-init-"));
		try {
			expect(hasOpenSpecConfig(project)).toBeFalse();
			mkdirSync(join(project, "openspec"), { recursive: true });
			writeFileSync(join(project, "openspec", "config.yaml"), "schema: fusion-driven\n");
			expect(hasOpenSpecConfig(project)).toBeTrue();
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	});
});