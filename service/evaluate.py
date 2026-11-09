"""Offline regression evaluation. Reads originals; writes a separate optional report."""
import argparse
import json
from pathlib import Path

from .results import analyze, decode, summarize

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EXPECTED = ROOT / 'tests/TradeMatch_1to1_Test_Pack/expected'


def expected_for(filename, folder=DEFAULT_EXPECTED):
    stem = Path(filename).stem
    path = folder / (stem + '.answer.json')
    if path.is_file():
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else None
    return None


def filename_for(payload):
    for step in payload.get('output', []):
        for block in step.get('content', []):
            from .results import metadata
            for source in metadata(block).get('source_files', []):
                if isinstance(source, dict) and source.get('file_name'):
                    return str(source['file_name'])
    return str(payload.get('id', 'unknown')) + '.pdf'


def evaluate(folder, expected_dir=DEFAULT_EXPECTED, decision_node=''):
    cases = []
    for path in sorted(folder.glob('job_*.raw.json')):
        payload = decode(json.loads(path.read_text()))
        filename = filename_for(payload)
        analysis = analyze(payload, decision_node=decision_node, expected=expected_for(filename, expected_dir))
        cases.append({'filename': filename, 'analysis': analysis})
    return {'source': str(folder.resolve()), 'scope': 'Studio output and technical/evidence auditing; no business rejudgment.',
            'summary': summarize([v['analysis'] for v in cases]), 'cases': cases}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--expected-dir', type=Path, default=DEFAULT_EXPECTED)
    parser.add_argument('--decision-node', default='')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    report = evaluate(args.folder, args.expected_dir, args.decision_node)
    if args.output:
        if args.output.resolve().is_relative_to(args.folder.resolve()):
            parser.error('원본 결과 폴더 밖에 별도 평가 파일을 저장하세요.')
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report['summary'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
