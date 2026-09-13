export interface IntegrationCapability {
  name: "serena" | "hindsight";
  available: boolean;
  reads: boolean;
  writes: boolean;
  reason?: string;
}

export interface SupplementalFact {
  key: string;
  value: unknown;
  source: "serena" | "hindsight";
  authority: "supplemental";
}

export type IntegrationProbe = () => boolean | Promise<boolean>;
export type IntegrationRead = (query: string) => Promise<readonly { key: string; value: unknown }[]>;
export type BrokeredSerenaWrite = (request: {
  tool: "serena_write";
  path: string;
  value: unknown;
}) => Promise<unknown>;

export class OptionalIntegrationAdapter {
  constructor(
    readonly name: "serena" | "hindsight",
    private readonly probe?: IntegrationProbe,
    private readonly readProvider?: IntegrationRead,
    private readonly writeBroker?: BrokeredSerenaWrite,
  ) {}

  async capability(): Promise<IntegrationCapability> {
    const available = Boolean(this.probe && await this.probe());
    return {
      name: this.name,
      available,
      reads: available && Boolean(this.readProvider),
      writes: available && this.name === "serena" && Boolean(this.writeBroker),
      reason: available ? undefined : `${this.name} adapter is not installed`,
    };
  }

  async read(query: string): Promise<SupplementalFact[]> {
    const capability = await this.capability();
    if (!capability.reads || !this.readProvider) return [];
    return (await this.readProvider(query)).map((fact) => ({
      ...fact,
      source: this.name,
      authority: "supplemental",
    }));
  }

  async write(path: string, value: unknown): Promise<unknown> {
    const capability = await this.capability();
    if (this.name !== "serena" || !capability.writes || !this.writeBroker) {
      throw new Error(`${this.name} write capability is unavailable`);
    }
    return this.writeBroker({ tool: "serena_write", path, value });
  }
}

export function applyAuthoritativePrecedence(
  authoritative: Readonly<Record<string, unknown>>,
  supplemental: readonly SupplementalFact[],
): Readonly<Record<string, unknown>> {
  const merged: Record<string, unknown> = {};
  for (const fact of supplemental) {
    if (!(fact.key in authoritative)) merged[fact.key] = fact.value;
  }
  return { ...merged, ...authoritative };
}