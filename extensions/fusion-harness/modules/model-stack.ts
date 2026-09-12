import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type HexColor = `#${string}`;

export interface ChildToolRule {
	inherit?: boolean;
	include?: string[];
	exclude?: string[];
}

export interface ChildToolConfig {
	read?: string[] | ChildToolRule;
	write?: string[] | ChildToolRule;
}

export interface ChildConfig {
	extensions?: string[];
	tools?: ChildToolConfig;
}

export interface ModelSlot {
	id: string;
	name: string;
	model: string;
	thinking: Thinking;
	color: HexColor;
	architect: boolean;
	primary: boolean;
	systemPrompt?: string;
	systemPromptSource?: string;
	/**
	 * Extra prompts APPENDED after the slot's base system prompt — the base being the
	 * `system_prompt` override when set, or pi's own default when not (children receive
	 * these via pi's repeatable --append-system-prompt, so the default is never rebuilt
	 * here). YAML: `append_system_prompt` takes one entry or a list; each entry is
	 * inline text or a file path relative to the YAML.
	 */
	appendSystemPrompts: string[];
	child?: ChildConfig;
}

export interface ModelStack {
	codename: string;
	configPath?: string;
	child?: ChildConfig;
	slots: ModelSlot[];
	architect: ModelSlot;
	primaryBuilder: ModelSlot;
	builders: ModelSlot[];
}

export interface LegacyStackOptions {
	architectModel: string;
	builderModel: string;
	architectThinking: Thinking;
	builderThinking: Thinking;
	architectSystemPrompt?: string;
	builderSystemPrompt?: string;
}

const THINKING_ALIASES: Record<string, Thinking> = {
	off: "off",
	none: "off",
	minimal: "minimal",
	min: "minimal",
	low: "low",
	medium: "medium",
	med: "medium",
	high: "high",
	hi: "high",
	xhigh: "xhigh",
	xhi: "xhigh",
	max: "max",
};

export const SLOT_COLOR_PALETTE: HexColor[] = ["#22D3EE", "#F59E0B", "#A78BFA", "#34D399", "#F472B6"];
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const SLOT_NAME_RE = /^[A-Za-z0-9_-]{1,16}$/;
const MODEL_RE = /^[^/\s]+\/[^\s]+$/;

export function resolveThinking(raw: unknown, fallback: Thinking = "medium"): Thinking | undefined {
	if (raw === undefined || raw === null || raw === "") return fallback;
	return typeof raw === "string" ? THINKING_ALIASES[raw.trim().toLowerCase()] : undefined;
}

export function slotId(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "slot";
}

function stableHash(input: string): number {
	let hash = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function resolvePrompt(raw: unknown, configDir: string, label: string, errors: string[]): { text?: string; source?: string } {
	if (raw === undefined || raw === null || raw === "") return {};
	if (typeof raw !== "string") {
		errors.push(`${label}.system_prompt must be a string (inline text or file path)`);
		return {};
	}
	const candidate = path.isAbsolute(raw) ? raw : path.resolve(configDir, raw);
	try {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return { text: fs.readFileSync(candidate, "utf8"), source: candidate };
		}
	} catch (error) {
		errors.push(`${label}.system_prompt could not be read at ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
	if (path.isAbsolute(raw) || raw.startsWith("./") || raw.startsWith("../") || raw.endsWith(".md") || raw.endsWith(".txt")) {
		errors.push(`${label}.system_prompt path does not exist: ${candidate}`);
		return {};
	}
	return { text: raw };
}

function codenameFromPath(configPath: string): string {
	const base = path.basename(configPath).replace(/\.(?:yaml|yml)$/i, "");
	return base.replace(/^model-stack-/, "") || "stack";
}

function parseChildExtensions(raw: unknown, configDir: string, label: string, errors: string[]): string[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) {
		errors.push(`${label}.extensions must be an array of extension sources`);
		return undefined;
	}
	const extensions: string[] = [];
	for (let index = 0; index < raw.length; index++) {
		const entry = raw[index];
		if (typeof entry !== "string") {
			errors.push(`${label}.extensions[${index}] must be a string`);
			continue;
		}
		const normalized = normalizeExtensionSource(entry.trim(), configDir);
		if (!normalized) {
			errors.push(`${label}.extensions[${index}] must not be empty`);
			continue;
		}
		extensions.push(normalized);
	}
	return extensions;
}

function parseChildTools(raw: unknown, label: string, errors: string[]): ChildToolConfig | undefined {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		errors.push(`${label}.tools must be a mapping`);
		return undefined;
	}
	const toolsValue = raw as Record<string, unknown>;
	const allowedToolKeys = new Set(["read", "write"]);
	for (const key of Object.keys(toolsValue)) {
		if (!allowedToolKeys.has(key)) errors.push(`${label}.tools contains unknown key ${JSON.stringify(key)}`);
	}
	const read = parseToolEntry(toolsValue.read, `${label}.tools.read`, errors);
	const write = parseToolEntry(toolsValue.write, `${label}.tools.write`, errors);
	if (read === undefined && write === undefined) return undefined;

	const readList = explicitIncludes(read);
	const writeList = explicitIncludes(write);
	for (const name of readList) {
		if (writeList.includes(name)) errors.push(`${label}.tools declares ${JSON.stringify(name)} as both read and write`);
	}

	const tools: ChildToolConfig = {};
	if (read !== undefined) tools.read = read;
	if (write !== undefined) tools.write = write;
	return tools;
}

function parseToolEntry(raw: unknown, label: string, errors: string[]): string[] | ChildToolRule | undefined {
	if (raw === undefined) return undefined;
	if (Array.isArray(raw)) return parseToolList(raw, label, errors);
	if (!raw || typeof raw !== "object") {
		errors.push(`${label} must be an array of tool names or a mapping with include/exclude`);
		return undefined;
	}
	const value = raw as Record<string, unknown>;
	const allowedKeys = new Set(["inherit", "include", "exclude"]);
	for (const key of Object.keys(value)) if (!allowedKeys.has(key)) errors.push(`${label} contains unknown key ${JSON.stringify(key)}`);

	let inherit: boolean | undefined;
	if (value.inherit !== undefined) {
		if (typeof value.inherit !== "boolean") errors.push(`${label}.inherit must be boolean`);
		else inherit = value.inherit;
	}
	const include = parseToolList(value.include, `${label}.include`, errors);
	const exclude = parseToolList(value.exclude, `${label}.exclude`, errors);
	if (include === undefined && exclude === undefined && inherit === undefined) {
		errors.push(`${label} object must set at least one of inherit/include/exclude`);
		return undefined;
	}

	const includeList = include ?? [];
	const excludeList = exclude ?? [];
	for (const name of includeList) {
		if (excludeList.includes(name)) errors.push(`${label} includes and excludes ${JSON.stringify(name)}`);
	}

	const rule: ChildToolRule = {};
	if (inherit !== undefined) rule.inherit = inherit;
	if (include !== undefined) rule.include = include;
	if (exclude !== undefined) rule.exclude = exclude;
	return rule;
}

function explicitIncludes(value: string[] | ChildToolRule | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value;
	return value.include ?? [];
}

function parseChildConfig(raw: unknown, configDir: string, label: string, errors: string[]): ChildConfig | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		errors.push(`${label} must be a mapping`);
		return undefined;
	}
	const value = raw as Record<string, unknown>;
	const allowedKeys = new Set(["extensions", "tools"]);
	for (const key of Object.keys(value)) if (!allowedKeys.has(key)) errors.push(`${label} contains unknown key ${JSON.stringify(key)}`);

	const extensions = parseChildExtensions(value.extensions, configDir, label, errors);
	const tools = parseChildTools(value.tools, label, errors);

	const config: ChildConfig = {};
	if (extensions !== undefined) config.extensions = extensions;
	if (tools !== undefined) config.tools = tools;
	return config;
}

function normalizeExtensionSource(source: string, configDir: string): string {
	if (!source) return "";
	if (source.startsWith("npm:") || source.startsWith("git:")) return source;
	if (path.isAbsolute(source)) return source;
	if (source.startsWith("./") || source.startsWith("../")) return path.resolve(configDir, source);
	return source;
}

function parseToolList(raw: unknown, label: string, errors: string[]): string[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) {
		errors.push(`${label} must be an array of tool names`);
		return undefined;
	}
	const names: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < raw.length; index++) {
		const entry = raw[index];
		if (typeof entry !== "string") {
			errors.push(`${label}[${index}] must be a string`);
			continue;
		}
		const name = entry.trim();
		if (!name) {
			errors.push(`${label}[${index}] must not be empty`);
			continue;
		}
		if (name.includes(",")) {
			errors.push(`${label}[${index}] must not contain commas`);
			continue;
		}
		if (seen.has(name)) {
			errors.push(`${label} contains duplicate tool name ${JSON.stringify(name)}`);
			continue;
		}
		seen.add(name);
		names.push(name);
	}
	return names;
}

export function loadModelStack(configPathInput: string): ModelStack {
	const configPath = path.resolve(configPathInput);
	let source: string;
	try {
		source = fs.readFileSync(configPath, "utf8");
	} catch (error) {
		throw new Error(`fusion-harness: model-stack config invalid (${configPath}):\n- file is unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(source);
	} catch (error) {
		throw new Error(`fusion-harness: model-stack config invalid (${configPath}):\n- YAML parse failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	const errors: string[] = [];
	let globalChild: ChildConfig | undefined;
	let slotEntries: unknown[];
	if (Array.isArray(parsed)) {
		slotEntries = parsed;
	} else if (parsed && typeof parsed === "object") {
		const top = parsed as Record<string, unknown>;
		const allowedTopKeys = new Set(["child", "slots"]);
		for (const key of Object.keys(top)) if (!allowedTopKeys.has(key)) errors.push(`top-level object contains unknown key ${JSON.stringify(key)}`);
		globalChild = parseChildConfig(top.child, path.dirname(configPath), "child", errors);
		if (!Array.isArray(top.slots)) {
			errors.push("top-level object field slots must be a list of model slots");
			slotEntries = [];
		} else {
			slotEntries = top.slots;
		}
	} else {
		throw new Error(`fusion-harness: model-stack config invalid (${configPath}):\n- top-level YAML value must be a list of model slots or an object with slots`);
	}
	if (slotEntries.length < 2 || slotEntries.length > 5) errors.push(`slot count must be between 2 and 5; found ${slotEntries.length}`);

	const codename = codenameFromPath(configPath);
	const configDir = path.dirname(configPath);
	const drafts: Array<Omit<ModelSlot, "color"> & { color?: HexColor }> = [];
	const names = new Set<string>();
	const ids = new Set<string>();

	for (let index = 0; index < slotEntries.length; index++) {
		const raw = slotEntries[index];
		const label = `slot[${index}]`;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			errors.push(`${label} must be a mapping`);
			continue;
		}
		const value = raw as Record<string, unknown>;
		const allowedKeys = new Set(["name", "model", "thinking", "color", "architect", "primary", "system_prompt", "append_system_prompt", "child"]);
		for (const key of Object.keys(value)) if (!allowedKeys.has(key)) errors.push(`${label} contains unknown key ${JSON.stringify(key)}`);
		const name = typeof value.name === "string" ? value.name.trim() : "";
		if (!SLOT_NAME_RE.test(name)) errors.push(`${label}.name must match [A-Za-z0-9_-]+ and be 1-16 characters; found ${JSON.stringify(value.name)}`);
		const id = slotId(name || `slot-${index + 1}`);
		if (names.has(name.toLowerCase())) errors.push(`${label}.name duplicates another slot: ${name}`);
		if (ids.has(id)) errors.push(`${label}.id duplicates another slot after normalization: ${id}`);
		names.add(name.toLowerCase());
		ids.add(id);

		const model = typeof value.model === "string" ? value.model.trim() : "";
		if (!MODEL_RE.test(model)) errors.push(`${label}.model must be fully qualified as provider/id; found ${JSON.stringify(value.model)}`);

		const thinking = resolveThinking(value.thinking);
		if (!thinking) errors.push(`${label}.thinking is invalid: ${JSON.stringify(value.thinking)}`);

		const architect = value.architect === true;
		const primary = value.primary === true;
		if (value.architect !== undefined && typeof value.architect !== "boolean") errors.push(`${label}.architect must be boolean`);
		if (value.primary !== undefined && typeof value.primary !== "boolean") errors.push(`${label}.primary must be boolean`);
		if (architect && primary) errors.push(`${label} is the architect and cannot be primary; primary is only for the Main builder`);

		let color: HexColor | undefined;
		if (value.color !== undefined && value.color !== null && value.color !== "") {
			if (typeof value.color !== "string" || !HEX_COLOR_RE.test(value.color.trim())) {
				errors.push(`${label}.color must be a quoted six-digit #RRGGBB value; found ${JSON.stringify(value.color)}`);
			} else {
				color = value.color.trim().toUpperCase() as HexColor;
			}
		}
		const prompt = resolvePrompt(value.system_prompt, configDir, label, errors);
		// append_system_prompt: one entry or a list; each entry inline text or a file
		// path relative to the YAML — same resolution rules as system_prompt.
		const appendSystemPrompts: string[] = [];
		if (value.append_system_prompt !== undefined && value.append_system_prompt !== null && value.append_system_prompt !== "") {
			const rawAppends = Array.isArray(value.append_system_prompt) ? value.append_system_prompt : [value.append_system_prompt];
			for (let appendIndex = 0; appendIndex < rawAppends.length; appendIndex++) {
				const resolved = resolvePrompt(rawAppends[appendIndex], configDir, `${label}.append_system_prompt[${appendIndex}]`, errors);
				if (resolved.text?.trim()) appendSystemPrompts.push(resolved.text);
			}
		}
		const child = parseChildConfig(value.child, configDir, `${label}.child`, errors);
		drafts.push({
			id,
			name: name || `slot-${index + 1}`,
			model,
			thinking: thinking ?? "medium",
			architect,
			primary,
			systemPrompt: prompt.text,
			systemPromptSource: prompt.source,
			appendSystemPrompts,
			child,
			color,
		});
	}

	const architectDrafts = drafts.filter((slot) => slot.architect);
	const builders = drafts.filter((slot) => !slot.architect);
	const primaries = builders.filter((slot) => slot.primary);
	if (architectDrafts.length !== 1) errors.push(`exactly one slot must set architect: true; found ${architectDrafts.length}`);
	if (builders.length < 1) errors.push("at least one non-architect builder slot is required");
	if (primaries.length !== 1) errors.push(`exactly one non-architect builder must set primary: true; found ${primaries.length}`);

	const explicitColors = new Set<string>();
	for (const slot of drafts) {
		if (!slot.color) continue;
		if (explicitColors.has(slot.color)) errors.push(`color ${slot.color} is assigned to more than one slot`);
		explicitColors.add(slot.color);
	}

	if (errors.length) {
		throw new Error(`fusion-harness: model-stack config invalid (${configPath}):\n${errors.map((error) => `- ${error}`).join("\n")}`);
	}

	const usedColors = new Set(explicitColors);
	const slots: ModelSlot[] = drafts.map((draft) => {
		let color = draft.color;
		if (!color) {
			const preferred = draft.architect ? "#A78BFA" : SLOT_COLOR_PALETTE[stableHash(`${codename}:${draft.id}`) % SLOT_COLOR_PALETTE.length];
			const ordered = [preferred as HexColor, ...SLOT_COLOR_PALETTE];
			color = ordered.find((candidate) => !usedColors.has(candidate)) ?? preferred as HexColor;
		}
		usedColors.add(color);
		return { ...draft, color } as ModelSlot;
	});

	const architect = slots.find((slot) => slot.architect)!;
	const stackBuilders = slots.filter((slot) => !slot.architect);
	const primaryBuilder = stackBuilders.find((slot) => slot.primary)!;
	return { codename, configPath, child: globalChild, slots, architect, primaryBuilder, builders: stackBuilders };
}

export function synthesizeLegacyStack(options: LegacyStackOptions): ModelStack {
	const architect: ModelSlot = {
		id: "architect",
		name: "architect",
		model: options.architectModel,
		thinking: options.architectThinking,
		color: "#A78BFA",
		architect: true,
		primary: false,
		systemPrompt: options.architectSystemPrompt,
		appendSystemPrompts: [],
		child: undefined,
	};
	const primaryBuilder: ModelSlot = {
		id: "main",
		name: "main",
		model: options.builderModel,
		thinking: options.builderThinking,
		color: "#F59E0B",
		architect: false,
		primary: true,
		systemPrompt: options.builderSystemPrompt,
		appendSystemPrompts: [],
		child: undefined,
	};
	return { codename: "legacy", slots: [architect, primaryBuilder], architect, primaryBuilder, builders: [primaryBuilder] };
}

export function orderedSlots(stack: ModelStack): ModelSlot[] {
	return [stack.architect, stack.primaryBuilder, ...stack.builders.filter((slot) => slot.id !== stack.primaryBuilder.id)];
}

export function cloneStack(stack: ModelStack): ModelStack {
	const cloneToolEntry = (entry: string[] | ChildToolRule | undefined): string[] | ChildToolRule | undefined => {
		if (entry === undefined) return undefined;
		if (Array.isArray(entry)) return [...entry];
		return {
			inherit: entry.inherit,
			include: entry.include ? [...entry.include] : undefined,
			exclude: entry.exclude ? [...entry.exclude] : undefined,
		};
	};

	const slots = stack.slots.map((slot) => ({
		...slot,
		appendSystemPrompts: [...slot.appendSystemPrompts],
		child: slot.child
			? {
				...slot.child,
				extensions: slot.child.extensions ? [...slot.child.extensions] : undefined,
				tools: slot.child.tools
					? {
						read: cloneToolEntry(slot.child.tools.read),
						write: cloneToolEntry(slot.child.tools.write),
					}
					: undefined,
			}
			: undefined,
	}));
	const architect = slots.find((slot) => slot.id === stack.architect.id)!;
	const primaryBuilder = slots.find((slot) => slot.id === stack.primaryBuilder.id)!;
	return {
		...stack,
		child: stack.child
			? {
				...stack.child,
				extensions: stack.child.extensions ? [...stack.child.extensions] : undefined,
				tools: stack.child.tools
					? {
						read: cloneToolEntry(stack.child.tools.read),
						write: cloneToolEntry(stack.child.tools.write),
					}
					: undefined,
			}
			: undefined,
		slots,
		architect,
		primaryBuilder,
		builders: slots.filter((slot) => !slot.architect),
	};
}
