#!/usr/bin/env python3
"""Author the PFC boost example.

    build_pfc_boost.py <output.gsim_sch>

A boost converter fed from the mains through a full-bridge rectifier -- the
front end of almost every offline supply. 230 V RMS at 50 Hz in, boosted onto a
400 V bus.

Open-loop on purpose: the switch runs at a fixed 100 kHz / 50 % duty, so what
the waveforms show is the rectified line voltage and the inductor current
envelope, not power-factor correction as a control problem. Closing that loop
needs a current reference multiplied by the rectified line shape, which belongs
in an article rather than in a first example -- the point here is the topology
and that it compiles and runs.
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

#: 230 V RMS -> 325 V peak, 50 Hz.
LINE_PEAK = 325.0
LINE_FREQ = 50.0


def build() -> Schematic:
    sheet = Schematic("pfc_boost", "PFC boost front end", grid=20)

    add(sheet, "source.voltage.sin", "vac", VO=0.0, VA=LINE_PEAK, FREQ=LINE_FREQ)

    # Full-bridge rectifier. d1/d3 conduct on the positive half cycle,
    # d2/d4 on the negative one, so the bridge output is always positive.
    for name in ("d1", "d2", "d3", "d4"):
        add(sheet, "ideal.diode", name)

    add(sheet, "passive.inductor", "lboost", L=1e-3)
    add(sheet, "ideal.switch", "sw", r_on=0.05)
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
    add(sheet, "ideal.diode", "dboost")
    add(sheet, "passive.capacitor", "cbus", C=100e-6)
    add(sheet, "passive.resistor", "rload", R=400.0)
    add(sheet, "routing.ground", "gnd")

    # The two AC terminals of the bridge.
    sheet.connect(("vac", "p"), ("d1", "a"), kind=EL)
    sheet.connect(("vac", "p"), ("d2", "k"), kind=EL)
    sheet.connect(("vac", "n"), ("d3", "a"), kind=EL)
    sheet.connect(("vac", "n"), ("d4", "k"), kind=EL)

    # The bridge's positive rail feeds the boost inductor; its return is ground.
    sheet.connect(("d1", "k"), ("lboost", "p"), kind=EL)
    sheet.connect(("d3", "k"), ("lboost", "p"), kind=EL)
    sheet.connect(("d2", "a"), ("gnd", "gnd"), kind=EL)
    sheet.connect(("d4", "a"), ("gnd", "gnd"), kind=EL)

    # Boost stage.
    sheet.connect(("lboost", "n"), ("sw", "d"), kind=EL)
    sheet.connect(("sw", "s"), ("gnd", "gnd"), kind=EL)
    sheet.connect(("dboost", "a"), ("lboost", "n"), kind=EL)
    sheet.connect(("dboost", "k"), ("cbus", "p"), kind=EL)
    sheet.connect(("dboost", "k"), ("rload", "p"), kind=EL)

    sheet.connect(("gate", "out"), ("gate_drive", "in"), kind=SIG)
    sheet.connect(("gate_drive", "out"), ("sw", "g"), kind=EL)

    sheet.connect(("cbus", "n"), ("gnd", "gnd"), kind=EL)
    sheet.connect(("rload", "n"), ("gnd", "gnd"), kind=EL)

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
