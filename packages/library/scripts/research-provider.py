"""Optional provider processes; no installation, ambient host auth, or presentation runtime."""
import asyncio
import importlib.metadata
import json
import sys
import contextlib
import io
import os


def main():
    request = json.load(sys.stdin)
    provider = request.get("provider")
    if provider == "gpt-researcher":
        if request.get("billing_authorized") is not True:
            raise RuntimeError("gpt_researcher_missing_authorized_api_budget")
        from gpt_researcher import GPTResearcher
        if importlib.metadata.version('gpt-researcher') != request.get('expected_version'):
            raise RuntimeError('unreviewed_gpt_researcher_version')

        async def run():
            researcher = GPTResearcher(query=request["query"], report_type="research_report", verbose=False, config_path=request["config_path"])
            await researcher.conduct_research()
            return {"schema_version": 1, "provider": provider, "version": importlib.metadata.version("gpt-researcher"), "sources": researcher.get_research_sources(), "cost": researcher.get_costs()}
        with contextlib.redirect_stdout(io.StringIO()):
            result = asyncio.run(run())
    elif provider == "docling":
        if request.get("model_downloads_authorized") is not True:
            raise RuntimeError("document_extraction_unavailable_models_not_authorized")
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
        from docling.document_converter import DocumentConverter
        if importlib.metadata.version('docling') != request.get('expected_version'):
            raise RuntimeError('unreviewed_docling_version')
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.datamodel.base_models import InputFormat
        from docling.document_converter import PdfFormatOption
        options = PdfPipelineOptions(artifacts_path=request["artifacts_path"])
        options.do_ocr = False
        options.enable_remote_services = False
        converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
        document = converter.convert(request["document_path"]).document
        sections = []
        for item, _level in document.iterate_items():
            provenance = [{"page": p.page_no, "bbox": p.bbox.model_dump()} for p in getattr(item, "prov", [])]
            text = item.export_to_markdown(document) if hasattr(item, "export_to_markdown") else getattr(item, "text", "")
            sections.append({"locator": item.self_ref, "text": text, "provenance": provenance})
        result = {"schema_version": 1, "provider": provider, "version": importlib.metadata.version("docling"), "text": document.export_to_markdown(), "sections": sections}
    else:
        raise RuntimeError("unsupported_provider")
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        json.dump({"status": "not_configured", "error": str(error)}, sys.stdout)
        sys.exit(1)
