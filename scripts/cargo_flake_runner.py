#!/usr/bin/env python3
"""Run a Cargo test binary with a separate libtest result log."""

import hashlib
import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    output, binary, *arguments = sys.argv[1:]
    binary = os.path.abspath(binary)
    directory = Path(output) / hashlib.sha256(os.fsencode(binary)).hexdigest()
    directory.mkdir()
    (directory / "binary").write_text(binary, encoding="utf-8")
    result = subprocess.run([binary, *arguments, "--logfile", str(directory / "results")])
    return result.returncode if result.returncode >= 0 else 128 - result.returncode


if __name__ == "__main__":
    sys.exit(main())
