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

from _builder import add, cell, write_document
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

    # Laid out explicitly rather than by `auto_arrange()`, which placed these nine
    # blocks on a 40-unit grid and produced 18 overlapping pairs (#145). The power
    # path runs left to right along row 1, the gate chain sits on row 3 under the
    # switch it drives, and the ground rail is row 3 centre. Shunt elements are
    # rotated so their ports face the output node above and the rail below.
    #
    # The inductor sits in column 4 rather than 3 for a reason a document-level
    # check cannot see: the wire from the switch source risers up at the
    # inductor's left port, and in column 3 that riser ran straight through the
    # switch's own refdes, so "S1" rendered as "S|". Found by rendering the sheet
    # and looking at it, which is the only way that class of fault is ever found.
    vin = add(sheet, "source.voltage.dc", "vin", V=48.0, at=cell(0, 1), rotation=90)
    sw = add(sheet, "ideal.switch", "sw", r_on=0.01, at=cell(2, 1))
    gate = add(
        sheet,
        "source.pulsewave",
        "gate",
        at=cell(0, 3),
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
    drive = add(sheet, "converter.sig2phys", "gate_drive", at=cell(1, 3))
    free = add(sheet, "ideal.diode", "dfw", at=cell(2, 2), rotation=270)
    choke = add(sheet, "passive.inductor", "l1", L=100e-6, at=cell(4, 1))
    out_cap = add(sheet, "passive.capacitor", "cout", C=220e-6, at=cell(5, 2), rotation=90)
    load = add(sheet, "passive.resistor", "rload", R=5.0, at=cell(6, 2), rotation=90)
    gnd = add(sheet, "routing.ground", "gnd", at=cell(3, 3))

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
    # 5 ms at 100 ns. The output filter is L = 100 uH with C = 220 uF into 5 ohm,
    # so the LC pair rings at 1/(2*pi*sqrt(LC)) = 1.07 kHz with Q = R*sqrt(C/L) =
    # 7.4 -- the startup envelope takes about 2.2 ms to decay. 5 ms shows that
    # settle and roughly two milliseconds of steady state after it. 100 ns is a
    # hundred samples per 10 us switching period, enough to see the ripple rather
    # than alias it.
    write_document(sheet, out, t_end=5e-3, t_step=1e-7)
    print(f"wrote {out}")
    print(f"compiles to {len(netlist.splitlines())} netlist lines")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
