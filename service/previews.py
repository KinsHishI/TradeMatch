"""Render the exact source PDF in an isolated PyMuPDF process."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

ASSETS = Path(__file__).parent / 'demo_previews'


def renderer():
    return 'pymupdf' if importlib.util.find_spec('pymupdf') else None


def cached_preview(pdf, page):
    manifest = ASSETS / 'manifest.json'
    if not manifest.is_file():
        return None
    digest = hashlib.sha256(pdf.read_bytes()).hexdigest()
    value = json.loads(manifest.read_text()).get(digest, {}).get(str(page))
    if not value or not re.fullmatch(r'TM11_\d{3}-page-\d+\.png', value):
        return None
    path = ASSETS / value
    return path if path.is_file() else None


def render_page(pdf, page, directory):
    if type(page) is not int or not 1 <= page <= 1000:
        raise ValueError('원본 페이지 번호를 확인하세요.')
    existing = cached_preview(pdf, page)
    if existing:
        return existing
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / f'page-{page}.png'
    if output.is_file():
        return output
    temp = output.with_suffix('.tmp.png')
    try:
        # MuPDF does not support concurrent Python threads. Isolate each render;
        # terminate malformed/slow documents without blocking API polling workers.
        subprocess.run([sys.executable, '-m', 'service.previews', str(pdf.resolve()), str(page), str(temp.resolve())],
                       cwd=Path(__file__).resolve().parents[1], check=True, timeout=20,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        temp.replace(output)
    except (subprocess.SubprocessError, OSError):
        temp.unlink(missing_ok=True)
        raise ValueError('원본 페이지를 표시하지 못했습니다. 원본 PDF 크게 보기를 사용하세요.') from None
    return output


def _render(pdf, page, output):
    import pymupdf
    with pymupdf.open(pdf) as document:
        if document.needs_pass or not 1 <= page <= document.page_count:
            raise ValueError('페이지 또는 PDF 암호를 확인하세요.')
        source = document[page - 1]
        # Bound bitmap dimensions even for unusually large PDF page sizes.
        longest = max(source.rect.width, source.rect.height)
        if longest <= 0:
            raise ValueError('PDF 페이지 크기를 확인하세요.')
        scale = min(110 / 72, 2200 / longest)
        source.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).save(output)


if __name__ == '__main__':
    _render(sys.argv[1], int(sys.argv[2]), sys.argv[3])
