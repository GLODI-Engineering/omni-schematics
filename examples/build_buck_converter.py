#!/usr/bin/env python3
"""Author the buck converter example.

    build_buck_converter.py <output.gsim_sch>

A textbook synchronous-rectifier-free buck: a switch chopping a DC rail into an
LC filter, with a freewheeling diode carrying the inductor current while the
switch is off. 48 V in, ~19 V out at 40 % duty into 5 ohm.

This replaces a version that computed every terminal coordinate by hand. That
document had drifted out of step with the engine in three separate ways at
once, none of which anything noticed:

* `passive.switch.voltage` -- a block type the engine no longer declares at all;
* `physical-electrical.source.voltage_dc` and
  `physical-electrical.semiconductor.diode` -- aliases that resolve in the
  catalogue and in the symbol registry, and that the **netlist emitter
  rejects**, so the sheet looked right in the palette and could not compile;
* a four-terminal gate drive (`cp`/`cn`) for a switch whose gate is now a
  single signal port.

Everything the engine can answer for itself is now asked of it (see
`_builder.py`): parameter defaults, paradigm, domain, placement and routing.
"""

from __future__ import annotations

import pathlib
import sys

# Explicit, because `python -I` drops the script's own directory from sys.path
# and the checker is entitled to run this in isolated mode.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from _builder import add
from gsim_tools.schematic import Schematic

EL = "physical-electrical"
SIG = "signal"

#: 100 kHz at 40 % duty. Rise and fall are a hundredth of the period rather
#: than zero: an ideal edge is a discontinuity the integrator has to resolve by
#: shortening its step, and the switching instant is where this circuit's error
#: is set.
PERIOD = 10e-6
DUTY = 0.4
EDGE = PERIOD / 100


def build() -> Schematic:
    sheet = Schematic("buck_converter", "Buck converter", grid=20)

    vin = add(sheet, "source.voltage.dc", "vin", V=48.0)
    sw = add(sheet, "ideal.switch", "sw", r_on=0.01)
    gate = add(
        sheet,
        "source.pulsewave",
        "gate",
        v1=0.0,
        v2=5.0,
        tr=EDGE,
        tf=EDGE,
        pw=PERIOD * DUTY,
        per=PERIOD,
    )
    # A signal-flow block cannot touch a physical-network one directly, however
    # the ports are typed -- the rule is per paradigm. The gate drive therefore
    # goes through the engine's own converter rather than being wired straight
    # to the switch.
    drive = add(sheet, "converter.sig2phys", "gate_drive")
    free = add(sheet, "ideal.diode", "dfw")
    choke = add(sheet, "passive.inductor", "l1", L=100e-6)
    out_cap = add(sheet, "passive.capacitor", "cout", C=220e-6)
    load = add(sheet, "passive.resistor", "rload", R=5.0)
    gnd = add(sheet, "routing.ground", "gnd")

    for block in (vin, sw, gate, drive, free, choke, out_cap, load, gnd):
        assert block is not None

    sheet.connect(("vin", "p"), ("sw", "d"), kind=EL)
    sheet.connect(("gate", "out"), ("gate_drive", "in"), kind=SIG)
    sheet.connect(("gate_drive", "out"), ("sw", "g"), kind=EL)

    # The switching node: switch source, diode cathode, inductor.
    sheet.connect(("sw", "s"), ("l1", "p"), kind=EL)
    sheet.connect(("dfw", "k"), ("sw", "s"), kind=EL)
    sheet.connect(("dfw", "a"), ("gnd", "gnd"), kind=EL)

    # The output node.
    sheet.connect(("l1", "n"), ("cout", "p"), kind=EL)
    sheet.connect(("l1", "n"), ("rload", "p"), kind=EL)

    sheet.connect(("cout", "n"), ("gnd", "gnd"), kind=EL)
    sheet.connect(("rload", "n"), ("gnd", "gnd"), kind=EL)
    sheet.connect(("vin", "n"), ("gnd", "gnd"), kind=EL)

    sheet.auto_arrange()
    return sheet


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    sheet = build()
    # Compiled here, not only in the checker: a generator that emits a document
    # the engine cannot compile has not done its job, and finding that out at
    # authoring time is cheaper than finding it out in CI.
    netlist = sheet.compile("general-simulator")
    out = pathlib.Path(argv[1])
    out.write_text(sheet.save())
    print(f"wrote {out}")
    print(f"compiles to {len(netlist.splitlines())} netlist lines")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
