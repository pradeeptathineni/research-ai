#!/usr/bin/env python3

# scripts/private-pdf-extract.py - Extract bounded text from PDF bytes on stdin.
# Usage: python3 scripts/private-pdf-extract.py < document.pdf
#
# --
# This fixed helper accepts no paths or options and writes only a small JSON result.

import io
import json
import sys

try:
    import resource
except ImportError:
    resource = None

MAX_INPUT = 4 * 1024 * 1024
MAX_PAGES = 256
MAX_TEXT_UNITS = 256_000
MAX_TEXT_BYTES = 768_000


def fail(code: str) -> None:
    print(json.dumps({"error": code}, separators=(",", ":")))
    raise SystemExit(2)


def limit_process() -> None:
    if resource is None:
        return
    try:
        resource.setrlimit(resource.RLIMIT_CPU, (8, 10))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except (OSError, ValueError):
        pass
    if hasattr(resource, "RLIMIT_AS"):
        try:
            soft, hard = resource.getrlimit(resource.RLIMIT_AS)
            cap = 768 * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (min(cap, soft) if soft > 0 else cap, min(cap, hard) if hard > 0 else cap))
        except (OSError, ValueError):
            pass


def main() -> None:
    limit_process()
    try:
        import pypdf
        from pypdf import PdfReader
    except ImportError:
        fail("pdf_parser_unavailable")
    if pypdf.__version__ != "6.15.0":
        fail("pdf_parser_version_mismatch")
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT:
        fail("pdf_too_large")
    if b"%PDF-" not in data[:1024]:
        fail("invalid_pdf_header")
    try:
        reader = PdfReader(io.BytesIO(data), strict=True, root_object_recovery_limit=10_000)
        if reader.is_encrypted:
            fail("pdf_encrypted")
        if len(reader.pages) > MAX_PAGES:
            fail("pdf_page_limit")
        pages: list[str] = []
        total_units = 0
        total_bytes = 0
        for page in reader.pages:
            text = page.extract_text()
            if not isinstance(text, str):
                fail("pdf_text_unavailable")
            total_units += len(text.encode("utf-16-le")) // 2
            total_bytes += len(text.encode("utf-8"))
            if total_units > MAX_TEXT_UNITS or total_bytes > MAX_TEXT_BYTES:
                fail("pdf_text_limit")
            pages.append(text)
    except SystemExit:
        raise
    except Exception:
        fail("pdf_malformed_or_unsupported")
    print(json.dumps({"extractor": "pypdf-6.15.0", "pages": pages}, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
