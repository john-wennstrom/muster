export class InjectedFault extends Error {
  constructor(readonly point: string) {
    super(`Injected fault at ${point}`);
    this.name = "InjectedFault";
  }
}

export class DeterministicFaultInjector<TPoint extends string> {
  private triggered = false;

  constructor(readonly target: TPoint) {}

  inject(point: TPoint): void {
    if (!this.triggered && point === this.target) {
      this.triggered = true;
      throw new InjectedFault(point);
    }
  }

  get didTrigger(): boolean {
    return this.triggered;
  }
}