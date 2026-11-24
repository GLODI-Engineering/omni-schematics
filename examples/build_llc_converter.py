#!/usr/bin/env python3
"""Author the LLC resonant converter example.

    build_llc_converter.py <output.gsim_sch>

A half-bridge LLC: two switches chop a 400 V bus into a resonant tank, the tank
drives a transformer, and a secondary bridge rectifies it. 400 V in, ~48 V out.

The three reactive elements the name refers to:

* `lr`  -- the series resonant inductor,
* `cr`  -- the series resonant capacitor,
* `lm`  -- the magnetising inductance, in parallel with the primary.

`passive.transformer` is an ideal two-winding transformer, so it has no
magnetising inductance of its own; `lm` is placed across the primary explicitly
rather than left implicit, which is also the honest way to show what sets the
lower resonant frequency.

$$ f_{r} = \\frac{1}{2\\pi\\sqrt{L_r C_r}} \\qquad
   f_{m} = \\frac{1}{2\\pi\\sqrt{(L_r + L_m) C_r}} $$

With the values here, $f_r \\approx 95$ kHz and $f_m \\approx 30$ kHz. The half
bridge runs at 100 kHz, just above $f_r$, which is where an LLC is normally
operated.

The two gate drives are complementary with no dead time: switching is ideal
here, and dead time is a property of a real gate driver rather than of the
topology. An example that needs it can delay `gate_lo` with its `td`.
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


def build() -> Schematic:
    sheet = Schematic("llc_converter", "LLC resonant converter", grid=20)

    # Explicit layout (#145). Bus at the left, half bridge stacked in column 1,
    # resonant tank and transformer along row 1, secondary bridge in columns 6-7
    # with its upper pair on row 0 and lower pair on row 2, output at the right.
    # The two gate chains sit on rows 3 and 4, each under the leg it drives.
    add(sheet, "source.voltage.dc", "vbus", V=400.0, at=cell(0, 1), rotation=90)

    # Half bridge.
    add(sheet, "ideal.switch", "sw_hi", r_on=0.05, at=cell(1, 0))
    add(sheet, "ideal.switch", "sw_lo", r_on=0.05, at=cell(1, 2))
    add(
        sheet,
        "source.pulsewave",
        "gate_hi",
        at=cell(0, 3),
        v1=0.0,
        v2=5.0,
        tr=EDGE,
        tf=EDGE,
        pw=HALF,
        per=PERIOD,
    )
    # The complement: the same waveform delayed by half a period.
    add(
        sheet,
        "source.pulsewave",
        "gate_lo",
        at=cell(0, 4),
        v1=0.0,
        v2=5.0,
        td=HALF,
        tr=EDGE,
        tf=EDGE,
        pw=HALF,
        per=PERIOD,
    )
    add(sheet, "converter.sig2phys", "drive_hi", at=cell(1, 3))
    add(sheet, "converter.sig2phys", "drive_lo", at=cell(1, 4))

    # Resonant tank and transformer.
    add(sheet, "passive.inductor", "lr", L=28e-6, at=cell(2, 1))
    add(sheet, "passive.capacitor", "cr", C=100e-9, at=cell(3, 1))
    add(sheet, "passive.inductor", "lm", L=250e-6, at=cell(4, 1), rotation=90)
    add(sheet, "passive.transformer", "tx", n=8.0, at=cell(5, 1))

    # Secondary bridge rectifier.
    for name, spot in (
        ("ds1", cell(6, 0)),
        ("ds3", cell(7, 0)),
        ("ds2", cell(6, 2)),
        ("ds4", cell(7, 2)),
    ):
        add(sheet, "ideal.diode", name, at=spot)

    add(sheet, "passive.capacitor", "cout", C=470e-6, at=cell(8, 1), rotation=90)
    add(sheet, "passive.resistor", "rload", R=5.0, at=cell(9, 1), rotation=90)
    add(sheet, "routing.ground", "gnd", at=cell(3, 3))

    # Bus across the half bridge.
    sheet.connect(("vbus", "p"), ("sw_hi", "d"), kind=EL)
    sheet.connect(("sw_hi", "s"), ("sw_lo", "d"), kind=EL)
    sheet.connect(("sw_lo", "s"), ("gnd", "gnd"), kind=EL)
    sheet.connect(("vbus", "n"), ("gnd", "gnd"), kind=EL)

    # Gate drives.
    sheet.connect(("gate_hi", "out"), ("drive_hi", "in"), kind=SIG)
    sheet.connect(("drive_hi", "out"), ("sw_hi", "g"), kind=EL)
    sheet.connect(("gate_lo", "out"), ("drive_lo", "in"), kind=SIG)
    sheet.connect(("drive_lo", "out"), ("sw_lo", "g"), kind=EL)

    # Tank: midpoint -> lr -> cr -> primary, with lm across the primary.
    sheet.connect(("sw_hi", "s"), ("lr", "p"), kind=EL)
    sheet.connect(("lr", "n"), ("cr", "p"), kind=EL)
    sheet.connect(("cr", "n"), ("tx", "p1"), kind=EL)
    sheet.connect(("tx", "n1"), ("gnd", "gnd"), kind=EL)
    sheet.connect(("lm", "p"), ("tx", "p1"), kind=EL)
    sheet.connect(("lm", "n"), ("tx", "n1"), kind=EL)

    # Secondary into the bridge.
    sheet.connect(("tx", "p2"), ("ds1", "a"), kind=EL)
    sheet.connect(("tx", "p2"), ("ds2", "k"), kind=EL)
    sheet.connect(("tx", "n2"), ("ds3", "a"), kind=EL)
    sheet.connect(("tx", "n2"), ("ds4", "k"), kind=EL)

    sheet.connect(("ds1", "k"), ("cout", "p"), kind=EL)
    sheet.connect(("ds3", "k"), ("cout", "p"), kind=EL)
    sheet.connect(("ds2", "a"), ("gnd", "gnd"), kind=EL)
    sheet.connect(("ds4", "a"), ("gnd", "gnd"), kind=EL)

    sheet.connect(("cout", "p"), ("rload", "p"), kind=EL)
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
    # 10 ms at 100 ns. The tank resonates at 1/(2*pi*sqrt(Lr*Cr)) = 95.1 kHz with
    # Lr = 28 uH and Cr = 100 nF, so driving it at 100 kHz puts this sheet just
    # above resonance -- which is the point of the example, and needs a fine step
    # to see. The output is C = 470 uF into 5 ohm, a 2.35 ms time constant, so
    # 10 ms is about four of them and the envelope has settled by the end.
    write_document(sheet, out, t_end=10e-3, t_step=1e-7)
    print(f"wrote {out}")
    print(f"compiles to {len(netlist.splitlines())} netlist lines")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
