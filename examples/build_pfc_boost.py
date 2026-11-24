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

from _builder import add, cell, write_document
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

    # Explicit layout (#145). The line enters at the left, the bridge's upper pair
    # sits on row 0 feeding the positive rail and the lower pair on row 3 returning
    # to ground, then the boost stage runs left to right along row 1 with its
    # switch below the switching node and the gate chain on row 4.
    add(
        sheet,
        "source.voltage.sin",
        "vac",
        at=cell(0, 2),
        rotation=90,
        VO=0.0,
        VA=LINE_PEAK,
        FREQ=LINE_FREQ,
    )

    # Full-bridge rectifier. d1/d3 conduct on the positive half cycle,
    # d2/d4 on the negative one, so the bridge output is always positive.
    for name, spot in (
        ("d1", cell(1, 0)),
        ("d3", cell(2, 0)),
        ("d2", cell(1, 3)),
        ("d4", cell(2, 3)),
    ):
        add(sheet, "ideal.diode", name, at=spot)

    add(sheet, "passive.inductor", "lboost", L=1e-3, at=cell(3, 1))
    add(sheet, "ideal.switch", "sw", r_on=0.05, at=cell(4, 2))
    add(
        sheet,
        "source.pulsewave",
        "gate",
        at=cell(3, 4),
        v1=0.0,
        v2=5.0,
        tr=EDGE,
        tf=EDGE,
        pw=PERIOD * DUTY,
        per=PERIOD,
    )
    add(sheet, "converter.sig2phys", "gate_drive", at=cell(4, 4))
    add(sheet, "ideal.diode", "dboost", at=cell(5, 1))
    add(sheet, "passive.capacitor", "cbus", C=100e-6, at=cell(6, 2), rotation=90)
    add(sheet, "passive.resistor", "rload", R=400.0, at=cell(7, 2), rotation=90)
    add(sheet, "routing.ground", "gnd", at=cell(5, 3))

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

    return sheet


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    sheet = build()
    netlist = sheet.compile("general-simulator")
    out = pathlib.Path(argv[1])
    # 40 ms at 200 ns: two full 50 Hz line cycles, which is the thing this sheet
    # is for -- the rectified line envelope and the switching riding on it. The
    # bus is deliberately *not* settled at the end of it: C = 100 uF into 400 ohm
    # is a 40 ms time constant, so a window long enough to settle would be ~120 ms
    # and 600,001 points, and this stage is open loop at a fixed 50 % duty so
    # there is no regulation to watch converge anyway.
    write_document(sheet, out, t_end=40e-3, t_step=2e-7)
    print(f"wrote {out}")
    print(f"compiles to {len(netlist.splitlines())} netlist lines")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
