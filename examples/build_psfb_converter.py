#!/usr/bin/env python3
"""Author the phase-shifted full-bridge example.

    build_psfb_converter.py <output.gsim_sch>

A full bridge driving a transformer into a rectifier and an LC output filter.
400 V in, ~48 V out.

What makes it *phase-shifted* rather than a plain full bridge: both legs run at
a fixed 50 % duty, and the output is controlled by sliding leg B's timing
against leg A's. The overlap between the two legs sets how long the transformer
sees the full bus, so

$$ V_{out} \\approx \\frac{V_{in}}{N}\\,\\frac{\\phi}{180^\\circ} $$

with $\\phi$ the phase shift in degrees. Here $\\phi = 144^\\circ$ into a turns
ratio of 8, for roughly 40 V before filter losses.

The phase shift is expressed as a fraction of the period, not in seconds,
because that is what it is -- `PHASE_SHIFT = 0.4` is 144 degrees whatever the
switching frequency.

Both legs are complementary with no dead time. In a real PSFB the dead time is
what the leakage inductance resonates into to achieve zero-voltage switching,
which is the whole reason the topology is used; it is deliberately left out
here so the example stays about the bridge and the phase shift. An ideal switch
has no output capacitance to resonate with in any case.
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
EDGE = PERIOD / 100
HALF = PERIOD / 2

#: As a fraction of the period: 0.4 is 144 degrees.
PHASE_SHIFT = 0.4
SHIFT = PERIOD * PHASE_SHIFT


def leg(sheet, name: str, delay: float, *, col: int, gate_row: int) -> None:
    """One half bridge, with complementary drives offset by `delay`.

    `col` is the layout column the two switches stack in; the four gate blocks go
    on `gate_row` and the row below it, in columns 0 and 1. Each leg is given its
    own pair of gate rows by the caller so the two legs' drive chains sit under
    the bridge rather than on top of each other -- this sheet had 87 overlapping
    pairs under `auto_arrange()`, the worst of the five (#145).
    """
    add(sheet, "ideal.switch", f"{name}_hi", r_on=0.05, at=cell(col, 0))
    add(sheet, "ideal.switch", f"{name}_lo", r_on=0.05, at=cell(col, 2))
    add(
        sheet,
        "source.pulsewave",
        f"g_{name}_hi",
        at=cell(0, gate_row),
        v1=0.0,
        v2=5.0,
        td=delay,
        tr=EDGE,
        tf=EDGE,
        pw=HALF,
        per=PERIOD,
    )
    add(
        sheet,
        "source.pulsewave",
        f"g_{name}_lo",
        at=cell(0, gate_row + 1),
        v1=0.0,
        v2=5.0,
        td=delay + HALF,
        tr=EDGE,
        tf=EDGE,
        pw=HALF,
        per=PERIOD,
    )
    add(sheet, "converter.sig2phys", f"d_{name}_hi", at=cell(1, gate_row))
    add(sheet, "converter.sig2phys", f"d_{name}_lo", at=cell(1, gate_row + 1))

    sheet.connect((f"g_{name}_hi", "out"), (f"d_{name}_hi", "in"), kind=SIG)
    sheet.connect((f"d_{name}_hi", "out"), (f"{name}_hi", "g"), kind=EL)
    sheet.connect((f"g_{name}_lo", "out"), (f"d_{name}_lo", "in"), kind=SIG)
    sheet.connect((f"d_{name}_lo", "out"), (f"{name}_lo", "g"), kind=EL)

    # The leg itself: bus -> hi -> midpoint -> lo -> ground.
    sheet.connect(("vbus", "p"), (f"{name}_hi", "d"), kind=EL)
    sheet.connect((f"{name}_hi", "s"), (f"{name}_lo", "d"), kind=EL)
    sheet.connect((f"{name}_lo", "s"), ("gnd", "gnd"), kind=EL)


def build() -> Schematic:
    sheet = Schematic("psfb_converter", "Phase-shifted full bridge", grid=20)

    # Explicit layout (#145). Bus at the left, the two bridge legs stacked in
    # columns 1 and 3 with the transformer between their midpoints, the secondary
    # bridge in columns 5-6, and the output filter to the right. Leg A's gate
    # chain is on rows 4-5 and leg B's on rows 6-7.
    add(sheet, "source.voltage.dc", "vbus", V=400.0, at=cell(0, 2), rotation=90)
    add(sheet, "routing.ground", "gnd", at=cell(2, 3))

    leg(sheet, "a", 0.0, col=1, gate_row=4)
    leg(sheet, "b", SHIFT, col=3, gate_row=6)

    add(sheet, "passive.transformer", "tx", n=8.0, at=cell(5, 1))

    for name, spot in (
        ("ds1", cell(6, 0)),
        ("ds3", cell(7, 0)),
        ("ds2", cell(6, 2)),
        ("ds4", cell(7, 2)),
    ):
        add(sheet, "ideal.diode", name, at=spot)

    add(sheet, "passive.inductor", "lout", L=20e-6, at=cell(8, 1))
    add(sheet, "passive.capacitor", "cout", C=470e-6, at=cell(9, 2), rotation=90)
    add(sheet, "passive.resistor", "rload", R=5.0, at=cell(10, 2), rotation=90)

    sheet.connect(("vbus", "n"), ("gnd", "gnd"), kind=EL)

    # The transformer primary sits between the two leg midpoints -- this is the
    # bridge, and the phase shift between the legs is what it sees.
    sheet.connect(("a_hi", "s"), ("tx", "p1"), kind=EL)
    sheet.connect(("b_hi", "s"), ("tx", "n1"), kind=EL)

    # Secondary bridge.
    sheet.connect(("tx", "p2"), ("ds1", "a"), kind=EL)
    sheet.connect(("tx", "p2"), ("ds2", "k"), kind=EL)
    sheet.connect(("tx", "n2"), ("ds3", "a"), kind=EL)
    sheet.connect(("tx", "n2"), ("ds4", "k"), kind=EL)
    sheet.connect(("ds1", "k"), ("lout", "p"), kind=EL)
    sheet.connect(("ds3", "k"), ("lout", "p"), kind=EL)
    sheet.connect(("ds2", "a"), ("gnd", "gnd"), kind=EL)
    sheet.connect(("ds4", "a"), ("gnd", "gnd"), kind=EL)

    # Output filter.
    sheet.connect(("lout", "n"), ("cout", "p"), kind=EL)
    sheet.connect(("lout", "n"), ("rload", "p"), kind=EL)
    sheet.connect(("cout", "n"), ("gnd", "gnd"), kind=EL)
    sheet.connect(("rload", "n"), ("gnd", "gnd"), kind=EL)

    return sheet


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    sheet = build()
    netlist = sheet.compile("general-simulator")
    out = pathlib.Path(argv[1])
    # 20 ms at 200 ns. The output filter is Lout = 20 uH with Cout = 470 uF into
    # 5 ohm: it resonates at 1.64 kHz with Q = R*sqrt(C/L) = 24, so its startup
    # ring decays with a 4.7 ms envelope and needs about four of those to be gone.
    # 200 ns is 50 samples per 10 us switching period, enough to place the phase
    # shift between the two legs, which is the quantity this sheet exists to show.
    write_document(sheet, out, t_end=20e-3, t_step=2e-7)
    print(f"wrote {out}")
    print(f"compiles to {len(netlist.splitlines())} netlist lines")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
