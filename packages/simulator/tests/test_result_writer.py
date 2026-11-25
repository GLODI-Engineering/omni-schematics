"""BE-16 — Result writer (manifest) tests.

Covers:
- manifest.json is canonical-key-ordered JSON.
- Every signal is described: its url, its shape and its dtype.
- No sample file is written beside it (#156).
- Two writes for the same sim_id raise without an explicit overwrite flag.

The round-trip assertions this file used to carry read the arrays back out of
``data.h5``. There is no sample file here to read them out of any more: the
samples a run produces are the solver's ``.gsim_samples`` container (#163),
which ``crates/waveform-store`` round-trips in Rust. What is left to check
about this writer is the index it writes, which is all it writes.
"""

from __future__ import annotations

import json
import pathlib
import uuid

import numpy as np
import pytest

from simulator.postprocess.result_writer import dataset_key


def _import_writer():  # type: ignore[no-untyped-def]
    try:
        from simulator.postprocess.result_writer import (
            ResultBundle,
            ResultWriter,
            SignalArray,
        )

        return ResultWriter, ResultBundle, SignalArray
    except (ImportError, AttributeError):
        pytest.xfail("simulator.postprocess.result_writer not yet implemented")


def _make_bundle(n_points: int = 100):  # type: ignore[no-untyped-def, return]
    _, ResultBundle, SignalArray = _import_writer()
    rng = np.random.default_rng(42)
    time = np.linspace(0, 10, n_points)
    signals = [
        SignalArray(
            name="scope_1.in",
            block_id="blk-scope",
            port_id="in",
            data=rng.standard_normal(n_points).astype("float32"),
        ),
        SignalArray(
            name="scope_1.out",
            block_id="blk-scope",
            port_id="out",
            data=rng.standard_normal(n_points).astype("float32"),
        ),
    ]
    return ResultBundle(
        sim_id=str(uuid.uuid4()),
        t_start=0.0,
        t_end=10.0,
        time=time,
        signals=signals,
    )


# ---------------------------------------------------------------------------
# No sample file (#156)
# ---------------------------------------------------------------------------


def test_no_sample_file_is_written(tmp_path: pathlib.Path) -> None:
    """The writer writes an index and nothing else.

    `data.h5` was the last sample file it wrote, and h5py went with it. A
    revived `time.npy` + `signals/*.npy` stopgap would count as a failure here
    too, deliberately: nothing reads either one, because the samples live in
    the container the solver writes.
    """
    ResultWriter, _, _ = _import_writer()
    bundle = _make_bundle()
    writer = ResultWriter(workdir=tmp_path)
    result_dir = writer.write(bundle)

    written = sorted(path.name for path in result_dir.iterdir())
    assert written == ["manifest.json"], f"unexpected files beside the manifest: {written}"


# ---------------------------------------------------------------------------
# Every signal is described
# ---------------------------------------------------------------------------


def test_manifest_describes_every_signal(tmp_path: pathlib.Path) -> None:
    ResultWriter, _, _ = _import_writer()
    bundle = _make_bundle()
    writer = ResultWriter(workdir=tmp_path)
    result_dir = writer.write(bundle)

    data = json.loads((result_dir / "manifest.json").read_text(encoding="utf-8"))
    by_url = {entry["url"]: entry for entry in data["signals"]}
    assert len(by_url) == len(bundle.signals), "two signals share a url"

    for sig in bundle.signals:
        key = dataset_key(sig.block_id, sig.port_id)
        url = f"results/{bundle.sim_id}/signals/{key}.npy"
        assert url in by_url, f"no manifest entry for signal {sig.name}"
        entry = by_url[url]
        assert entry["name"] == sig.name
        assert entry["shape"] == [len(sig.data)]
        # float32 for a sample, which is what the solver's container stores and
        # what the plot can show; the time vector stays float64 in the bundle.
        assert entry["dtype"] == "float32", f"{sig.name} is not float32: {entry['dtype']}"
        assert sig.data.dtype == np.float32
    assert bundle.time.dtype == np.float64


def test_manifest_records_the_sweep_extent(tmp_path: pathlib.Path) -> None:
    ResultWriter, _, _ = _import_writer()
    bundle = _make_bundle()
    writer = ResultWriter(workdir=tmp_path)
    result_dir = writer.write(bundle)

    data = json.loads((result_dir / "manifest.json").read_text(encoding="utf-8"))
    assert data["t_start"] == bundle.t_start
    assert data["t_end"] == bundle.t_end
    assert data["n_points"] == len(bundle.time)


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


def test_manifest_json_is_valid(tmp_path: pathlib.Path) -> None:
    ResultWriter, _, _ = _import_writer()
    bundle = _make_bundle()
    writer = ResultWriter(workdir=tmp_path)
    writer.write(bundle)

    manifest_path = tmp_path / "results" / bundle.sim_id / "manifest.json"
    assert manifest_path.exists()
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert data["sim_id"] == bundle.sim_id
    assert "signals" in data
    assert "t_start" in data
    assert "t_end" in data


def test_manifest_keys_are_sorted(tmp_path: pathlib.Path) -> None:
    """Canonical key order for git-friendly diffs."""
    ResultWriter, _, _ = _import_writer()
    bundle = _make_bundle()
    writer = ResultWriter(workdir=tmp_path)
    writer.write(bundle)

    manifest_path = tmp_path / "results" / bundle.sim_id / "manifest.json"
    raw = manifest_path.read_text(encoding="utf-8")
    parsed = json.loads(raw)
    keys = list(parsed.keys())
    assert keys == sorted(keys), f"Manifest keys are not sorted: {keys}"


def test_signal_urls_are_relative(tmp_path: pathlib.Path) -> None:
    ResultWriter, _, _ = _import_writer()
    bundle = _make_bundle()
    writer = ResultWriter(workdir=tmp_path)
    writer.write(bundle)

    manifest_path = tmp_path / "results" / bundle.sim_id / "manifest.json"
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    for sig_entry in data["signals"]:
        url = sig_entry["url"]
        assert not pathlib.Path(url).is_absolute(), f"URL must be relative: {url!r}"


# ---------------------------------------------------------------------------
# No silent overwrite
# ---------------------------------------------------------------------------


def test_second_write_same_sim_id_raises(tmp_path: pathlib.Path) -> None:
    ResultWriter, _ResultBundle, _SignalArray = _import_writer()
    bundle = _make_bundle()
    writer = ResultWriter(workdir=tmp_path)
    writer.write(bundle)

    with pytest.raises(Exception) as exc_info:
        writer.write(bundle)  # same sim_id, no overwrite flag

    msg = str(exc_info.value).lower()
    assert any(word in msg for word in ("exist", "overwrite", "duplicate", "already")), (
        f"Expected an overwrite-prevention error; got: {exc_info.value!r}"
    )
