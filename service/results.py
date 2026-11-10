"""Read Studio output and audit transport/contracts. No business verdict logic."""
import copy
import json
import re
from collections import Counter, defaultdict

STATUSES = {'PASS', 'FAIL', 'REQUIRES_HUMAN_REVIEW'}
KEYS = {'status', 'document_counts', 'relationships', 'checks', 'issues'}
BRANCHES = {'일치': 'PASS', '불일치': 'FAIL', '담당자 검토요약': 'REQUIRES_HUMAN_REVIEW',
            '검증완료_요약': 'PASS', '불일치_조치초안': 'FAIL', '담당자_검토요청': 'REQUIRES_HUMAN_REVIEW'}
CITATION = re.compile(r'【[^】]*】')


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('JSON에 중복 키가 있습니다.')
        result[key] = value
    return result


def _constant(_):
    raise ValueError('표준 JSON 숫자가 아닙니다.')


def decode(value):
    """Unwrap JSON transport strings, without removing fences or suffixes."""
    for _ in range(8):
        if not isinstance(value, str):
            return value
        value = json.loads(value, object_pairs_hook=_pairs, parse_constant=_constant)
    raise ValueError('JSON 문자열 포장이 너무 깊습니다.')


def metadata(block):
    try:
        value = decode(block.get('additional_values') or {})
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


def node_name(step):
    return re.sub(r'^Instruct\s*-\s*', '', str(step.get('model', ''))).strip()


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from _strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from _strings(child)


def contract_errors(result):
    errors = []
    if not isinstance(result, dict) or not KEYS <= set(result):
        return ['최종 결과에 필수 다섯 키가 없습니다.']
    if not isinstance(result['status'], str) or result['status'] not in STATUSES:
        errors.append('허용되지 않은 status입니다.')
    if set(result) - KEYS - {'report'}:
        errors.append('알 수 없는 최상위 키가 있습니다.')
    counts = result['document_counts']
    if not isinstance(counts, dict) or set(counts) != {'PO', 'CI', 'PL', 'BL', 'OTHER'}:
        errors.append('문서 개수의 다섯 항목이 맞지 않습니다.')
    elif any(v is not None and (type(v) is not int or v < 0) for v in counts.values()):
        errors.append('문서 개수는 음이 아닌 정수 또는 null이어야 합니다.')
    definitions = {
        'relationships': {'pair', 'from_documents', 'to_documents', 'mapping_type', 'basis'},
        'checks': {'check_id', 'documents', 'compared_values', 'result', 'basis'},
        'issues': {'type', 'documents', 'fields', 'detail'},
    }
    for key, fields in definitions.items():
        rows = result[key]
        if not isinstance(rows, list):
            errors.append(f'{key}는 배열이어야 합니다.')
            continue
        if key == 'checks' and not rows:
            errors.append('checks가 비어 있습니다.')
        for i, row in enumerate(rows):
            if not isinstance(row, dict) or set(row) != fields:
                errors.append(f'{key}[{i}]의 키가 맞지 않습니다.')
                continue
            for name in fields & {'documents', 'fields', 'from_documents', 'to_documents'}:
                if not isinstance(row[name], list) or any(not isinstance(v, str) for v in row[name]):
                    errors.append(f'{key}[{i}].{name}은 문자열 배열이어야 합니다.')
            for name in fields & {'check_id', 'basis', 'detail'}:
                if not isinstance(row[name], str):
                    errors.append(f'{key}[{i}].{name}은 문자열이어야 합니다.')
            if key == 'relationships':
                if not isinstance(row['pair'], str) or not isinstance(row['mapping_type'], str) or row['pair'] not in {'PO_CI', 'CI_PL', 'PL_BL'} or row['mapping_type'] not in {'1:1', '1:N', 'N:1', 'N:M', 'UNKNOWN'}:
                    errors.append(f'{key}[{i}]의 관계 유형이 맞지 않습니다.')
            elif key == 'issues':
                if not isinstance(row['type'], str) or row['type'] not in {'DISCREPANCY', 'MISSING_DATA', 'AMBIGUOUS_MAPPING', 'LOW_CONFIDENCE'}:
                    errors.append(f'{key}[{i}]의 issue 유형이 맞지 않습니다.')
            else:
                if not isinstance(row['result'], str) or row['result'] not in STATUSES:
                    errors.append(f'checks[{i}]의 결과가 맞지 않습니다.')
                values = row['compared_values']
                if not isinstance(values, list):
                    errors.append(f'checks[{i}].compared_values는 배열이어야 합니다.')
                    continue
                for j, value in enumerate(values):
                    if not isinstance(value, dict) or set(value) != {'document', 'field', 'value', 'unit'}:
                        errors.append(f'checks[{i}].compared_values[{j}]의 키가 맞지 않습니다.')
                    elif not isinstance(value['document'], str) or not isinstance(value['field'], str) or (value['unit'] is not None and not isinstance(value['unit'], str)):
                        errors.append(f'checks[{i}].compared_values[{j}]의 자료형이 맞지 않습니다.')
                    elif not _scalar_value(value['value']):
                        errors.append(f'checks[{i}].compared_values[{j}].value는 원본의 단일 값 또는 단일 값 배열이어야 합니다.')
    if 'report' in result and not isinstance(result['report'], str):
        errors.append('report는 문자열이어야 합니다.')
    return errors


def _scalar_value(value):
    scalar = lambda v: v is None or type(v) in {str, int, float, bool}
    return scalar(value) or isinstance(value, list) and all(scalar(v) for v in value)


def extract_documents(payload):
    documents = defaultdict(list)
    for step in payload.get('output', []):
        if step.get('step_type') != 'information-extract' and not str(step.get('model', '')).startswith('Information Extract - '):
            continue
        for block in step.get('content', []):
            try:
                value = decode(block.get('text', ''))
            except (ValueError, TypeError):
                continue
            if isinstance(value, dict):
                for key in ['po_number', 'invoice_number', 'packing_list_number', 'bl_number']:
                    if isinstance(value.get(key), str) and value[key]:
                        documents[value[key]].append(value)
                        break
    return documents


def _lookup(data, path):
    tokens = re.findall(r'([^.\[\]]+)|\[(\d+)\]', path)
    rebuilt = ''.join(('[' + index + ']') if index else (('.' if i else '') + key) for i, (key, index) in enumerate(tokens))
    if not tokens or rebuilt != path:
        raise KeyError(path)
    for key, index in tokens:
        data = data[int(index)] if index else data[key]
    return data


def evidence_audit(payload, result):
    documents = extract_documents(payload)
    counts = Counter()
    findings = []
    for check in result.get('checks', []):
        if not isinstance(check, dict):
            continue
        for item in check.get('compared_values', []) if isinstance(check.get('compared_values'), list) else []:
            if not isinstance(item, dict):
                continue
            finding = {k: item.get(k) for k in ['document', 'field', 'value']}
            finding['check_id'] = check.get('check_id')
            candidates = documents.get(item.get('document'), [])
            if len(candidates) != 1:
                counts['unverified_document'] += 1
                finding['reason'] = '원본 문서가 없거나 같은 번호의 여러 개정이 있어 자동 대조를 보류했습니다.'
                findings.append(finding)
                continue
            try:
                actual = _lookup(candidates[0], item['field'])
            except (KeyError, IndexError, TypeError, ValueError):
                counts['missing_path'] += 1
                finding['reason'] = '해당 Extract 문서에 이 필드 경로가 없습니다.'
                findings.append(finding)
                continue
            claimed = item.get('value')
            numeric = type(actual) in {int, float} and type(claimed) in {int, float}
            if actual == claimed and (type(actual) is type(claimed) or numeric):
                counts['exact'] += 1
            else:
                counts['value_difference'] += 1
                finding.update(reason='원본 Extract 값 또는 자료형과 다릅니다.', extracted_value=actual)
                findings.append(finding)
    return {'counts': dict(counts), 'findings': findings}


def _without_citations(value):
    if isinstance(value, str):
        return CITATION.sub('', value)
    if isinstance(value, dict):
        return {k: _without_citations(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_without_citations(v) for v in value]
    return value


def _report_text(text):
    for _ in range(8):
        try:
            value = json.loads(text)
        except (ValueError, TypeError):
            break
        if not isinstance(value, str):
            break
        text = value
    return re.sub(r'\s+', ' ', CITATION.sub('', text).replace('\\n', '\n')).strip()


def analyze(payload, *, decision_node='', expected=None):
    payload = decode(payload)
    if not isinstance(payload, dict):
        raise ValueError('API 응답은 JSON 객체여야 합니다.')
    steps = payload.get('output', [])
    candidates = []
    parse_errors = []
    instruct_steps = []
    bodies = {}
    texts = {}
    decision_seen = False
    for step in steps:
        if step.get('step_type') != 'instruct' and not str(step.get('model', '')).startswith('Instruct - '):
            continue
        name = node_name(step)
        instruct_steps.append(name)
        blocks = [v for v in step.get('content', []) if isinstance(v.get('text'), str)]
        if len(blocks) != 1:
            parse_errors.append({'node': name, 'message': '생성 본문이 한 블록이 아닙니다.'})
            continue
        enum = metadata(blocks[0]).get('enum')
        decision_seen = decision_seen or enum is not None
        texts[name] = blocks[0]['text']
        try:
            value = decode(blocks[0]['text'])
        except (ValueError, TypeError):
            if enum is not None or name == decision_node:
                parse_errors.append({'node': name, 'message': '원본 본문이 올바른 JSON이 아닙니다. 자동 보정하지 않았습니다.'})
            continue
        if isinstance(value, dict) and KEYS <= set(value):
            candidates.append({'node': name, 'result': value, 'enum': enum})
        if isinstance(value, dict):
            bodies[name] = value
    selected = None
    technical = []
    if decision_node:
        eligible = [v for v in candidates if v['node'] == decision_node]
    else:
        eligible = [v for v in candidates if v['enum'] is not None]
        if not eligible and not decision_seen:
            eligible = candidates
    if len(eligible) == 1:
        selected = eligible[0]
    elif eligible:
        # Several independent decisions (e.g. an Other branch) are not one verdict.
        technical.append('판정 후보가 여러 개입니다. 연결 설정에 판정 노드 이름을 지정하세요.')
    else:
        technical.append('판정 노드의 다섯 키 JSON을 확인할 수 없습니다.')
    if payload.get('status') != 'completed':
        selected = None
        technical.append('Studio 작업이 완료되지 않았습니다. 중간 출력을 최종 판정으로 표시하지 않습니다.')
    result = copy.deepcopy(selected['result']) if selected else None
    errors = contract_errors(result) if result is not None else ['최종 JSON을 확인할 수 없습니다.']
    technical.extend(errors)
    enum = selected['enum'] if selected else None
    branch = next((name for name in reversed(instruct_steps) if name in BRANCHES), None)
    status = result.get('status') if result else None
    status_enum_match = status == enum if enum is not None and status is not None else None
    enum_branch_match = BRANCHES[branch] == enum if branch and enum is not None else None
    if status_enum_match is False:
        technical.append('JSON status와 실제 결정값이 다릅니다. 원래 판정은 변경하지 않았습니다.')
    if enum_branch_match is False:
        technical.append('실제 결정값과 실행 분기가 다릅니다.')
    display_preserved = None
    if selected and branch:
        if branch in bodies and KEYS <= set(bodies[branch]):
            display_preserved = all(_without_citations(result[k]) == _without_citations(bodies[branch][k]) for k in KEYS)
        elif isinstance(result.get('report'), str) and branch in texts:
            display_preserved = _report_text(result['report']) == _report_text(texts[branch])
        if display_preserved is False:
            technical.append('마지막 출력이 판정 노드의 결과와 다릅니다. 서비스는 원본 판정 노드를 표시합니다.')
    audit = evidence_audit(payload, result) if result and not errors else {'counts': {}, 'findings': []}
    expected_status = expected.get('status') if isinstance(expected, dict) else None
    return {
        'job_id': payload.get('id'), 'job_status': payload.get('status'),
        'studio_status': status, 'decision_node': selected['node'] if selected else None,
        'decision_value': enum, 'executed_branch': branch,
        'status_enum_match': status_enum_match, 'enum_branch_match': enum_branch_match,
        'contract_valid': not errors, 'technical_issues': technical, 'parse_errors': parse_errors,
        'display_preserved_ignoring_citations': display_preserved,
        'citation_count': sum(len(CITATION.findall(v)) for v in _strings(result or {})),
        'evidence_audit': audit, 'result': result,
        'expected_status': expected_status,
        'expected_status_match': status == expected_status if expected_status else None,
        'python_changed_verdict': False,
    }


def delivery_failure(analysis):
    """Identify an explicit workflow delivery failure, without changing its verdict."""
    analysis = analysis or {}
    if analysis.get('contract_valid') is False:
        return 'invalid_output'
    result = analysis.get('result') or {}
    checks = result.get('checks') or []
    if (result.get('status') == 'REQUIRES_HUMAN_REVIEW'
            and any(c.get('check_id') == 'FINAL_INPUT_RESULT_MISSING' for c in checks)
            and all(c.get('result') == 'REQUIRES_HUMAN_REVIEW' and not c.get('documents') and not c.get('compared_values') for c in checks)
            and any(i.get('type') == 'MISSING_DATA' and 'input' in i.get('fields', []) for i in result.get('issues', []))):
        return 'workflow_input_missing'
    return None


def summarize(analyses):
    scored = [a for a in analyses if a.get('expected_status')]
    return {
        'total': len(analyses),
        'expected_cases': len(scored),
        'expected_matches': sum(a['expected_status_match'] is True for a in scored),
        'valid_json': sum(a['contract_valid'] for a in analyses),
        'status_enum_branch_matches': sum(a['status_enum_match'] is True and a['enum_branch_match'] is True for a in analyses),
        'evidence_findings': sum(len(a['evidence_audit']['findings']) for a in analyses),
        'python_changed_verdict': False,
    }
