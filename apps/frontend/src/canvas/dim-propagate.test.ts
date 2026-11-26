import { describe, expect, it } from "vitest";
import { type PropagateModel, propagate } from "./dim-propagate";

function expectDimMap(result: ReturnType<typeof propagate>): Map<string, number[]> {
  expect(result instanceof Map).toBe(true);
  if (!(result instanceof Map)) throw new Error(`Expected Map result, got ${result.error}`);
  return result;
}

describe("FE-65: dim-propagate", () => {
  it("test_propagate_scalar: a constant=1 → gain → scope chain produces dim [1] on every wire", () => {
    const model: PropagateModel = {
      blocks: [
        { id: "c1", type: "signal-flow.source.constant", params: { value: 1 } },
        { id: "g1", type: "signal-flow.math.gain", params: { k: 2 } },
        { id: "s1", type: "signal-flow.sink.scope" },
      ],
      wires: [
        { id: "w1", from: { block: "c1", port: "out" }, to: { block: "g1", port: "in" } },
        { id: "w2", from: { block: "g1", port: "out" }, to: { block: "s1", port: "in" } },
      ],
    };

    const dims = expectDimMap(propagate(model));
    expect(dims.get("w1")).toEqual([1]);
    expect(dims.get("w2")).toEqual([1]);
  });

  /*
   * The three tests that stood here asserted vector widths -- [3] through a
   * gain, [5] out of a mux, [2]+[3] out of a demux -- from a
   * `signal-flow.source.constant` carrying `value: [1, 2, 3]`.
   *
   * That document cannot exist. The catalogue declares `source.const` as
   * `{"out": "[1]"}` with `value` of type `number`: this engine has no vector
   * constant. The tests passed only because the catalogue had no signatures at
   * all before gsim-core 0.6.3 and the editor's own `BUILTIN_PORT_SIGS`
   * fallback inferred a width from the array literal -- an inference about a
   * sheet nobody could draw.
   *
   * They are replaced below by what is true and worth guarding: propagation
   * carries the declared width and does not invent one. The vector case is a
   * real gap, filed as gsim-core#96 (a port cannot declare a width that depends
   * on a parameter, so `state_space`'s `rows(c)` is inexpressible), and belongs
   * back here as soon as a component can say it carries a vector.
   */
  it("carries the declared width along a chain, and invents none", () => {
    const model: PropagateModel = {
      blocks: [
        { id: "c1", type: "signal-flow.source.constant", params: { value: 3 } },
        { id: "g1", type: "signal-flow.math.gain", params: { k: 2 } },
        { id: "s1", type: "signal-flow.sink.scope" },
      ],
      wires: [
        { id: "w1", from: { block: "c1", port: "out" }, to: { block: "g1", port: "in" } },
        { id: "w2", from: { block: "g1", port: "out" }, to: { block: "s1", port: "in" } },
      ],
    };

    const dims = expectDimMap(propagate(model));
    // The source declares [1]; the gain is `in: inherit` / `out: from(in)`, so
    // the width it passes on is the one it was given rather than one of its own.
    expect(dims.get("w1")).toEqual([1]);
    expect(dims.get("w2")).toEqual([1]);
  });

  it("does not read a width out of a parameter's array literal", () => {
    // The precise regression: an array in `params.value` must not become a
    // width, because the card the engine compiles takes a scalar there. A
    // propagation that guessed [3] here would draw a label no run could match.
    const model: PropagateModel = {
      blocks: [
        { id: "c1", type: "signal-flow.source.constant", params: { value: [1, 2, 3] } },
        { id: "s1", type: "signal-flow.sink.scope" },
      ],
      wires: [{ id: "w1", from: { block: "c1", port: "out" }, to: { block: "s1", port: "in" } }],
    };

    expect(expectDimMap(propagate(model)).get("w1")).toEqual([1]);
  });

  it.todo("a vector source widens a chain — needs gsim-core#96");

  it("test_propagate_signal_specification_pins: signal_specification dim=[4] pins downstream inherit chain to [4]", () => {
    const model: PropagateModel = {
      blocks: [
        { id: "c1", type: "signal-flow.source.constant", params: { value: [1, 2, 3] } },
        {
          id: "spec",
          type: "signal-flow.attributes.signal_specification",
          params: { dim: [4] },
        },
        { id: "g1", type: "signal-flow.math.gain", params: { k: 2 } },
        { id: "s1", type: "signal-flow.sink.scope" },
      ],
      wires: [
        { id: "w1", from: { block: "c1", port: "out" }, to: { block: "spec", port: "in" } },
        { id: "w2", from: { block: "spec", port: "out" }, to: { block: "g1", port: "in" } },
        { id: "w3", from: { block: "g1", port: "out" }, to: { block: "s1", port: "in" } },
      ],
    };

    const dims = expectDimMap(propagate(model));
    expect(dims.get("w2")).toEqual([4]);
    expect(dims.get("w3")).toEqual([4]);
  });

  it("test_dim_loop_detection: an inherit cycle raises DimLoopError naming all blocks in the cycle", () => {
    const model: PropagateModel = {
      blocks: [
        { id: "g1", type: "signal-flow.math.gain", params: { k: 1 } },
        { id: "g2", type: "signal-flow.math.gain", params: { k: 1 } },
      ],
      wires: [
        { id: "w1", from: { block: "g1", port: "out" }, to: { block: "g2", port: "in" } },
        { id: "w2", from: { block: "g2", port: "out" }, to: { block: "g1", port: "in" } },
      ],
    };

    const result = propagate(model);
    expect(result instanceof Map).toBe(false);
    if (result instanceof Map) return;

    expect(result.error).toBe("dim-loop");
    const cycleText = result.cycle.join(" ");
    expect(cycleText).toContain("g1");
    expect(cycleText).toContain("g2");
  });
});
