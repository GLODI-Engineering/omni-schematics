import { CancelledError, type ExecuteResult, type IpcClient, type WaveformSlice } from "../types";
import { STUB_MANIFEST, STUB_WAVEFORM } from "./fixtures";

type StubEvent = "kernel_status";
type Listener = (payload: unknown) => void;

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createStubKernel(): IpcClient & {
  on(event: StubEvent, listener: Listener): () => void;
} {
  const listeners = new Map<StubEvent, Set<Listener>>([["kernel_status", new Set()]]);

  const emit = (event: StubEvent, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(payload);
    }
  };

  return {
    async execute(_payload: unknown): Promise<ExecuteResult> {
      emit("kernel_status", "busy");
      return new Promise((resolve) => {
        window.setTimeout(() => {
          emit("kernel_status", "idle");
          resolve({ manifest: clone(STUB_MANIFEST) });
        }, 20);
      });
    },
    cancel(): void {
      throw new CancelledError();
    },
    async waveformGet(_simId: string, signals: string[]): Promise<WaveformSlice> {
      return clone({
        time: STUB_WAVEFORM.time,
        traces: STUB_WAVEFORM.traces.filter((trace) => signals.includes(trace.label)),
      });
    },
    subscribe(event, listener) {
      const typedEvent = event as StubEvent;
      listeners.get(typedEvent)?.add(listener);
      if (typedEvent === "kernel_status") {
        listener("idle");
      }
      return () => {
        listeners.get(typedEvent)?.delete(listener);
      };
    },
    on(event, listener) {
      listeners.get(event)?.add(listener);
      return () => {
        listeners.get(event)?.delete(listener);
      };
    },
  };
}

export default createStubKernel;
