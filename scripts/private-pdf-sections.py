#!/usr/bin/env python3

# scripts/private-pdf-sections.py - Read a bounded PDF outline from bytes on stdin.
#
# --
# This fixed helper accepts no paths or options and writes only a bounded JSON result.

import hashlib
import io
import json
import sys

try:
    import resource
except ImportError:
    resource = None

MAX_INPUT = 4 * 1024 * 1024
MAX_PAGES = 50
MAX_NODES = 200
MAX_DEPTH = 16
MAX_TITLE = 300
MAX_OUTPUT = 300_000


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
            resource.setrlimit(
                resource.RLIMIT_AS,
                (min(cap, soft) if soft > 0 else cap, min(cap, hard) if hard > 0 else cap),
            )
        except (OSError, ValueError):
            pass


def count_entries(values: list[object]) -> int:
    count = 0
    pending: list[object] = list(values)
    seen: set[int] = set()
    while pending:
        value = pending.pop()
        if isinstance(value, list):
            identity = id(value)
            if identity in seen:
                continue
            seen.add(identity)
            pending.extend(value)
        else:
            count += 1
    return count


def section_id(raw_sha256: str, position: tuple[int, ...]) -> str:
    path = "/".join(str(value) for value in position)
    return hashlib.sha256(f"{raw_sha256}:{path}".encode("ascii")).hexdigest()


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
        page_count = len(reader.pages)
        if page_count < 1 or page_count > MAX_PAGES:
            fail("pdf_page_limit")
    except SystemExit:
        raise
    except Exception:
        fail("pdf_malformed_or_unsupported")

    raw_digest = hashlib.sha256(data).hexdigest()
    try:
        outline = reader.outline
    except Exception:
        result = {
            "extractor": "pypdf-6.15.0",
            "outcome": "unavailable",
            "nodes": [],
            "omitted": 0,
        }
    else:
        if not isinstance(outline, list):
            result = {
                "extractor": "pypdf-6.15.0",
                "outcome": "unavailable",
                "nodes": [],
                "omitted": 0,
            }
        elif not outline:
            result = {
                "extractor": "pypdf-6.15.0",
                "outcome": "absent",
                "nodes": [],
                "omitted": 0,
            }
        else:
            flattened: list[dict[str, object]] = []
            omitted = 0

            def walk(
                entries: list[object],
                parent_id: str | None,
                parent_depth: int,
                parent_path: tuple[int, ...],
            ) -> None:
                nonlocal omitted
                previous_id: str | None = None
                previous_depth = parent_depth
                for index, item in enumerate(entries):
                    position = parent_path + (index,)
                    if isinstance(item, list):
                        if previous_id is None:
                            omitted += count_entries(item)
                        else:
                            walk(item, previous_id, previous_depth + 1, position)
                        continue
                    if len(flattened) >= MAX_NODES or parent_depth >= MAX_DEPTH:
                        omitted += 1 + count_entries(entries[index + 1 :])
                        break
                    try:
                        title = item.title
                        page_index = reader.get_destination_page_number(item)
                        if (
                            not isinstance(title, str)
                            or not title
                            or len(title) > MAX_TITLE
                            or page_index is None
                            or isinstance(page_index, bool)
                            or not isinstance(page_index, int)
                            or page_index < 0
                            or page_index >= page_count
                        ):
                            omitted += 1
                            previous_id = None
                            continue
                        title.encode("utf-8", "strict")
                    except Exception:
                        omitted += 1
                        previous_id = None
                        continue
                    identifier = section_id(raw_digest, position)
                    flattened.append(
                        {
                            "id": identifier,
                            "parent_id": parent_id,
                            "title": title,
                            "physical_start": page_index + 1,
                            "physical_end": page_count,
                            "_depth": parent_depth,
                        }
                    )
                    previous_id = identifier
                    previous_depth = parent_depth

            try:
                walk(outline, None, 0, ())
            except RecursionError:
                result = {
                    "extractor": "pypdf-6.15.0",
                    "outcome": "unavailable",
                    "nodes": [],
                    "omitted": 0,
                }
            else:
                for index, node in enumerate(flattened):
                    depth = int(node.pop("_depth"))
                    start = int(node["physical_start"])
                    end = page_count
                    for next_node in flattened[index + 1 :]:
                        if int(next_node["_depth"]) <= depth:
                            next_start = int(next_node["physical_start"])
                            end = max(start, next_start - 1)
                            break
                    node["physical_end"] = min(page_count, end)
                result = {
                    "extractor": "pypdf-6.15.0",
                    "outcome": "available" if flattened else "unavailable",
                    "nodes": flattened,
                    "omitted": omitted,
                }
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_OUTPUT:
        fail("pdf_outline_output_limit")
    sys.stdout.buffer.write(encoded + b"\n")


if __name__ == "__main__":
    main()
