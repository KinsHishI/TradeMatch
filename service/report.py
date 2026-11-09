"""Printable view of an existing Studio verdict, without another judgment."""
import html
import json
import base64
import hashlib
from pathlib import Path

from .results import CITATION


def style_text():
    return (Path(__file__).parent / 'static/report.css').read_text()


def style_hash():
    return 'sha256-' + base64.b64encode(hashlib.sha256(style_text().encode()).digest()).decode()


def report_html(row):
    escape = lambda value: html.escape(str(value if value is not None else '—'))
    clean = lambda value: escape(CITATION.sub('', str(value or '')).replace('\\n', '\n'))
    analysis = row.get('analysis', {})
    result = analysis.get('result') or {}
    blocks = []
    for check in result.get('checks', []) if isinstance(result.get('checks'), list) else []:
        if not isinstance(check, dict):
            continue
        values = []
        for v in check.get('compared_values', []) if isinstance(check.get('compared_values'), list) else []:
            if isinstance(v, dict):
                values.append('<tr>' + ''.join('<td>' + escape(x) + '</td>' for x in [v.get('document'), v.get('field'), json.dumps(v.get('value'), ensure_ascii=False), v.get('unit')]) + '</tr>')
        blocks.append(f'<section><h3>{escape(check.get("check_id"))} <span>{escape(check.get("result"))}</span></h3><p>{clean(check.get("basis"))}</p><table><thead><tr><th>문서</th><th>필드</th><th>원본 비교값</th><th>단위</th></tr></thead><tbody>{"".join(values)}</tbody></table></section>')
    issues = ''.join(f'<li><b>{escape(i.get("type"))}</b><p>{clean(i.get("detail"))}</p></li>' for i in (result.get('issues') or []) if isinstance(i, dict))
    return f'''<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>TradeMatch 검증 보고서</title><style>{style_text()}</style></head><body>
<header><b>TRADEMATCH</b><p>선적서류 정합성 검증 보고서</p></header>
<h1>{escape(row.get('filename'))}</h1><div class="verdict">Studio 판정: {escape(analysis.get('studio_status'))}</div>
<p>이 문서는 저장된 Studio 결과를 표시용으로 정리했습니다. Python이 업무 판정이나 원본 값을 수정하지 않았습니다.</p>
<dl><dt>실제 결정값</dt><dd>{escape(analysis.get('decision_value'))}</dd><dt>실행 분기</dt><dd>{escape(analysis.get('executed_branch'))}</dd><dt>Job ID</dt><dd>{escape(row.get('job_id'))}</dd><dt>기록된 Config</dt><dd>{escape(row.get('settings_snapshot', {}).get('config_version'))}</dd><dt>결과 출처</dt><dd>{escape(row.get('source'))}</dd></dl>
<h2>Studio 보고 내용</h2><p>{clean(result.get('report') or '상세 검사 결과와 확인 사항은 아래 기록을 참조하세요.')}</p>
<h2>불일치·검토 사항</h2><ul>{issues or '<li>Studio가 기록한 issues는 비어 있습니다.</li>'}</ul>
<h2>검사 근거</h2>{''.join(blocks)}
<footer>현재 제공 문서 범위의 정합성 검사입니다. 발행·통관 승인이나 전체 주문 이행 보증을 의미하지 않습니다. 인용 마커는 표시용 보고서에서만 숨겼으며 원본 API JSON은 별도로 보존됩니다. 브라우저 인쇄 기능으로 PDF로 저장할 수 있습니다.</footer></body></html>'''
