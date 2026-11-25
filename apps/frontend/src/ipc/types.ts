/**
 * What a run says about its signals, and the shape a window of them has.
 *
 * This file used to describe a WebSocket conversation: a request to send, a
 * result to await, a binary frame to decode, a client to hold. The sidecar that
 * answered it is gone (#162) -- a run is the extension host spawning the solver
 * (#159) and the plot is the viewer reading the `.gsim_samples` container
 * (#157) -- so what is left is the vocabulary both of those still speak.
 */

export interface WaveformTrace {
  label: string;
  values: number[];
  /** BE-47 signal metadata, carried through from the manifest entry so the
   * waveform viewer can tell AC/DC/noise results apart from transient ones
   * (axis labels, Bode-mode detection, unit display). Optional because
   * fixtures/tests may omit it; consumers should fall back sensibly. */
  analysis?: string;
  quantity?: string;
  unit?: string;
  domain?: string;
  /**
   * The block and port this trace came from, as the manifest records them.
   *
   * What a trace *is* cannot be read off its name: `V_out` says nothing about
   * whether a solver computed it or a file source replayed it from a capture.
   * The block can be looked up in the document, and its type answers that.
   */
  block?: string;
  port?: string;
}

export interface WaveformSlice {
  time: number[];
  traces: WaveformTrace[];
}

/**
 * What the run says about one of its signals.
 *
 * `SimulationManifest.signals` is a list of names, which is all the viewer
 * needed while every signal was something the solver computed. It is not
 * enough to tell a measured capture from a computed trace, and a run has
 * always known more than a name.
 */
export interface SignalDetail {
  name: string;
  /** The block that produced it, and which of its ports. */
  block?: string;
  port?: string;
  analysis?: string;
  quantity?: string;
  unit?: string;
  domain?: string;
}

export interface SimulationManifest {
  sim_id: string;
  signals: string[];
  t_start: number;
  t_end: number;
  /**
   * The same signals, with what the run knows about each.
   *
   * Optional, and in the same order as `signals` when present: a fixture that
   * answers with names alone stays valid, and a consumer that only wants names
   * is unaffected.
   */
  details?: SignalDetail[];
}

export interface DcOpEntry {
  node_or_branch: string;
  quantity: string;
  value: number;
  unit: string;
}
