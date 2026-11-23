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

from _builder import add
from gsim_tools.schematic import Schematic

EL = "physical-electrical"
SIG = "signal"

PERIOD = 10e-6
DUTY = 0.5
EDGE = PERIOD / 100


def build() -> Schematic:
    sheet = Schematic("boost_converter", "Boost converter", grid=20)

    add(sheet, "source.voltage.dc", "vin", V=12.0)
    add(sheet, "passive.inductor", "l1", L=220e-6)
    add(sheet, "ideal.switch", "sw", r_on=0.01)
    add(
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
    add(sheet, "converter.sig2phys", "gate_drive")
    add(sheet, "ideal.diode", "dout")
    add(sheet, "passive.capacitor", "cout", C=470e-6)
    add(sheet, "passive.resistor", "rload", R=20.0)
    add(sheet, "routing.ground", "gnd")

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

    sheet.auto_arrange()
    return sheet


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    sheet = build()
    netlist = sheet.compile("general-simulator")
    out = pathlib.Path(argv[1])
    out.write_text(sheet.save())
    print(f"wrote {out}")
    print(f"compiles to {len(netlist.splitlines())} netlist lines")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
