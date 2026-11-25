"""BE-09 — Binary frame encoder tests.

Covers:
- Header is exactly 128 bytes, padded, parseable as JSON.
- Frame total length = 128 + array.nbytes.
- dtype/shape match the array exactly.
- Round-trip for float32, float64, int32, int64 arrays of various shapes.

The three `encode_workspace_value` cases that used to close this file went with
the REPL (omni-schematics#161): `workspace_get` was the only caller of this
encoder, so what it did with a scalar is no longer a property of anything.
"""

from __future__ import annotations

import json

import numpy as np
import pytest


def _import_binary_frame():  # type: ignore[no-untyped-def]
    try:
        from kernel_sidecar.ipc.binary_frame import decode_array, encode_array

        return encode_array, decode_array
    except (ImportError, AttributeError):
        pytest.xfail("kernel_sidecar.ipc.binary_frame not yet implemented")


HEADER_LEN = 128


# ---------------------------------------------------------------------------
# Header structure
# ---------------------------------------------------------------------------


def test_header_is_exactly_128_bytes() -> None:
    encode_array, _ = _import_binary_frame()
    arr = np.zeros(10, dtype="float32")
    frame = encode_array(arr, request_id="r1")
    assert len(frame) >= HEADER_LEN
    header_bytes = frame[:HEADER_LEN]
    assert len(header_bytes) == HEADER_LEN


def test_header_parses_as_json() -> None:
    encode_array, _ = _import_binary_frame()
    arr = np.zeros(10, dtype="float32")
    frame = encode_array(arr, request_id="r1")
    header_str = frame[:HEADER_LEN].decode("ascii").rstrip()
    parsed = json.loads(header_str)
    assert "dtype" in parsed
    assert "shape" in parsed


def test_header_padding_does_not_corrupt_json() -> None:
    encode_array, _ = _import_binary_frame()
    arr = np.ones((3, 4), dtype="int32")
    frame = encode_array(arr, request_id="r2")
    # The header must be parseable even with trailing spaces
    header_str = frame[:HEADER_LEN].decode("ascii")
    parsed = json.loads(header_str)
    assert parsed["shape"] == [3, 4]


# ---------------------------------------------------------------------------
# Frame length
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "dtype,shape",
    [
        ("float32", (100,)),
        ("float64", (50, 2)),
        ("int32", (10, 10)),
        ("int64", (1,)),
    ],
)
def test_frame_length_equals_header_plus_nbytes(dtype: str, shape: tuple) -> None:
    encode_array, _ = _import_binary_frame()
    arr = np.zeros(shape, dtype=dtype)
    frame = encode_array(arr, request_id="r3")
    assert len(frame) == HEADER_LEN + arr.nbytes


# ---------------------------------------------------------------------------
# dtype / shape accuracy
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "dtype,shape",
    [
        ("float32", (100,)),
        ("float64", (50, 2)),
        ("int32", (10, 10)),
        ("int64", (7, 3, 2)),
    ],
)
def test_dtype_and_shape_in_header(dtype: str, shape: tuple) -> None:
    encode_array, _ = _import_binary_frame()
    arr = np.zeros(shape, dtype=dtype)
    frame = encode_array(arr, request_id="r4")
    header = json.loads(frame[:HEADER_LEN].decode("ascii"))
    assert header["dtype"] == dtype
    assert tuple(header["shape"]) == shape


# ---------------------------------------------------------------------------
# Round-trip
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "dtype,shape",
    [
        ("float32", (100,)),
        ("float64", (50, 2)),
        ("int32", (10, 10)),
        ("int64", (5,)),
    ],
)
def test_round_trip(dtype: str, shape: tuple) -> None:
    encode_array, decode_array = _import_binary_frame()
    rng = np.random.default_rng(42)
    arr = rng.standard_normal(shape).astype(dtype)
    frame = encode_array(arr, request_id="rt")
    recovered = decode_array(frame)
    np.testing.assert_array_equal(arr, recovered)
