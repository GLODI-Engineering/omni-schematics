#!/usr/bin/env python3
"""Author the boost converter example.

    build_boost_converter.py <output.gsim_sch>

A textbook boost: the switch shorts the inductor to ground to store energy, and
the diode passes that energy to the output capacitor when it opens. 12 V in,
~24 V out at 50 % duty into 20 ohm.

The inductor carries the input current continuously, which is the difference
from the buck worth seeing side by side -- there the inductor is on the output.
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

PERIOD = 10e-6
DUTY = 0.5
EDGE = PERIOD / 100


def build() -> Schematic:
    sheet = Schematic("boost_converter", "Boost converter", grid=20)

    # Explicit layout (#145). Power path left to right on row 1: source, choke,
    # then the diode lifting the output. The switch hangs below the switching node
    # it shunts to ground, and the gate chain runs along row 3 beneath it.
    add(sheet, "source.voltage.dc", "vin", V=12.0, at=cell(0, 1), rotation=90)
    add(sheet, "passive.inductor", "l1", L=220e-6, at=cell(1, 1))
    add(sheet, "ideal.switch", "sw", r_on=0.01, at=cell(2, 2))
    add(
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
    add(sheet, "converter.sig2phys", "gate_drive", at=cell(1, 3))
    add(sheet, "ideal.diode", "dout", at=cell(3, 1))
    add(sheet, "passive.capacitor", "cout", C=470e-6, at=cell(4, 2), rotation=90)
    add(sheet, "passive.resistor", "rload", R=20.0, at=cell(5, 2), rotation=90)
    add(sheet, "routing.ground", "gnd", at=cell(3, 3))

    # Input through the inductor to the switching node.
    sheet.connect(("vin", "p"), ("l1", "p"), kind=EL)
    sheet.connect(("l1", "n"), ("sw", "d"), kind=EL)

    # The switch pulls the switching node to ground; the diode lifts the output.
    sheet.connect(("sw", "s"), ("gnd", "gnd"), kind=EL)
    sheet.connect(("dout", "a"), ("l1", "n"), kind=EL)
    sheet.connect(("dout", "k"), ("cout", "p"), kind=EL)
    sheet.connect(("dout", "k"), ("rload", "p"), kind=EL)

    sheet.connect(("gate", "out"), ("gate_drive", "in"), kind=SIG)
    sheet.connect(("gate_drive", "out"), ("sw", "g"), kind=EL)

    sheet.connect(("cout", "n"), ("gnd", "gnd"), kind=EL)
    sheet.connect(("rload", "n"), ("gnd", "gnd"), kind=EL)
    sheet.connect(("vin", "n"), ("gnd", "gnd"), kind=EL)

    return sheet


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    sheet = build()
    netlist = sheet.compile("general-simulator")
    out = pathlib.Path(argv[1])
    # 30 ms at 200 ns. The output time constant is R*C = 20 ohm * 470 uF = 9.4 ms,
    # an order of magnitude slower than the buck's, so a 5 ms window would show a
    # converter still charging and nothing about its steady state. 30 ms is a
    # little over three time constants. 200 ns is 50 samples per 10 us switching
    # period -- coarser than the buck because 30 ms at 100 ns would be 300,001
    # points for no extra insight, and 50 samples still resolves an edge whose
    # rise time is a hundredth of the period.
    write_document(sheet, out, t_end=30e-3, t_step=2e-7)
    print(f"wrote {out}")
    print(f"compiles to {len(netlist.splitlines())} netlist lines")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
