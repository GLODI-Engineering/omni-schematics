"""#147 — what the kernel says when it cannot import its own compiler.

The failure this pins is not "the message is missing". The message was there, and
it was handled: a virtualenv holding exactly the seven wheels that `v0.7.0`
published answers Run with a `SolverUnavailable` rather than hanging or showing a
traceback. What it said was::

    gsim-tools is installed by hand rather than locked — see the note in the
    repository's root pyproject.toml under [tool.uv.sources] for the one-time step:

        uv pip install -e <sibling-repos-root>/gsim-tools

Every noun in that is a thing only a checkout has. The person most likely to read
it installed the extension from the Marketplace, built a virtualenv from the
release's wheels and pointed `omniSchematics.kernelPython` at it -- the documented
route -- so they have no `<sibling-repos-root>`, no root `pyproject.toml`, and no
way to act on any of it.

So these tests are about whether the advice is executable by whoever reads it,
which is a property worth a test precisely because it is the kind that rots back:
the next person to touch this file is likely to be working *in* a checkout, where
the old wording reads perfectly well.
"""

from __future__ import annotations

import re
import sys

from kernel_sidecar.ipc.handlers.simulate import _missing_compiler_message

REASON = "No module named 'gsim_tools'"


def test_it_names_the_interpreter_that_failed() -> None:
    """The one path that is always right.

    Whatever else the reader has, they have the interpreter the kernel is running
    in -- it is the thing that just failed the import, so it is by definition
    where the package has to end up.
    """
    assert sys.executable in _missing_compiler_message(REASON)


def test_the_install_command_can_be_pasted() -> None:
    """Not "install it into the kernel's environment", but the command itself.

    Quoted, because an interpreter path on Windows contains spaces far more often
    than not -- `C:\\Users\\...\\AppData\\Local\\omni-schematics\\kernel-venv`.
    """
    message = _missing_compiler_message(REASON)
    assert f'"{sys.executable}" -m pip install' in message


def test_it_says_where_to_get_the_wheel() -> None:
    """A reader with no checkout needs a URL, not a path.

    Neither package is on PyPI, so `pip install gsim-tools` does not work and
    saying it would be worse than saying nothing.
    """
    message = _missing_compiler_message(REASON)
    assert "github.com/GLODI-Engineering/gsim-tools/releases" in message


def test_it_does_not_send_a_release_user_to_a_checkout() -> None:
    """The actual regression.

    `<sibling-repos-root>` was a placeholder the reader was expected to fill in
    from knowledge they do not have. A checkout route may still be mentioned --
    it is genuinely shorter for a developer -- but it cannot be the only thing
    offered, and the placeholder cannot come back.
    """
    message = _missing_compiler_message(REASON)
    assert "<sibling-repos-root>" not in message
    # The checkout route is allowed, but only alongside something else: the
    # message has to contain an absolute interpreter path too.
    if "uv pip install -e" in message:
        assert sys.executable in message


def test_it_names_the_missing_package() -> None:
    """ "a package" is what the reader gets when the reason is unrecognised.

    Worth pinning both ways: the `gsim_tools` case is the one that happens, and
    the fallback must not claim the wrong package name for some other ImportError.
    """
    assert "gsim_tools" in _missing_compiler_message(REASON)
    other = _missing_compiler_message("No module named 'numpy'")
    assert "gsim_tools" not in other
    # And it points at gsim-core instead, since that is where the other
    # unpublished package comes from.
    assert "gsim-core/releases" in other


def test_it_still_carries_the_underlying_reason() -> None:
    """The ImportError text is what distinguishes this from the ten other ways
    Run can fail, and a bug report without it is a guessing game."""
    assert REASON in _missing_compiler_message(REASON)


def test_it_warns_that_uv_sync_prunes_it() -> None:
    """The failure that brings a developer back to this message a second time.

    Neither package is locked, so a sync removes both. Someone who has installed
    `gsim-tools` once and hit this again is owed the reason rather than left to
    wonder whether the first install worked.
    """
    message = _missing_compiler_message(REASON)
    assert re.search(r"uv sync.*prune", message, re.IGNORECASE | re.DOTALL)
