"""Allow running the package directly with ``python -m googleai_website_to_cli``."""

from __future__ import annotations

import sys

from googleai_website_to_cli.cli import main

sys.exit(main())
