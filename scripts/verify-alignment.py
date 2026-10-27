import argparse
import hashlib
import json
import re
import tarfile
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--archive', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
folder = root / 'docs/alignment'
read = lambda name: json.loads((folder / name).read_text())
baseline = read('baseline.json')
contracts = read('contracts.json')
components = read('components.json')
tests = read('tests.json')
phases = read('phases.json')
design = (root / 'docs/design/design.md').read_text()
design_hash = hashlib.sha256(design.encode()).hexdigest()
headings = set()
fenced = False
for line in design.splitlines():
    if line.startswith('```'):
        fenced = not fenced
    elif not fenced:
        heading = re.match(r'^#{1,6} (.+)$', line)
        if heading:
            headings.add(heading.group(1))
errors = []

if design_hash != baseline['design']['mainSha256']:
    errors.append('Design fingerprint differs from the approved phase baseline')
if contracts['designSha256'] != design_hash:
    errors.append('Contract census uses a different design fingerprint')

scenario_ids = set()
for label, rows in [('contracts', contracts['contracts']), ('components', components['components']), ('tests', tests['tests'])]:
    ids = [row['id'] for row in rows]
    if len(set(ids)) != len(ids):
        errors.append(f'{label} has duplicate IDs')
    for row in rows:
        if row['phase'] not in {f'P{i}' for i in range(1, 8)}:
            errors.append(f"{row['id']} has an invalid implementation phase")
        if row.get('section') and row['section'] not in headings:
            errors.append(f"{row['id']} references an unknown design heading: {row['section']}")
        if label == 'contracts':
            if not row.get('scenarios'):
                errors.append(f"{row['id']} has no observable test scenario")
            for scenario in row.get('scenarios', []):
                if scenario['id'] in scenario_ids:
                    errors.append(f"Duplicate scenario ID: {scenario['id']}")
                scenario_ids.add(scenario['id'])
                if not scenario.get('expectation'):
                    errors.append(f"{scenario['id']} has no expected result")
        elif row['disposition'] not in {'rewrite', 'remove', 'evaluate'}:
            errors.append(f"{row['id']} has an invalid disposition")
        elif row['disposition'] == 'evaluate' and not row.get('section') and not row['path'].startswith('.agents/'):
            errors.append(f"{row['id']} evaluates reuse without a design responsibility")

main_files = set(baseline['trackedMainFiles'])
local_files = set(baseline['files'])
all_files = main_files | local_files
for label, rows in [('components', components['components']), ('tests', tests['tests'])]:
    paths = [row['path'] for row in rows]
    if len(set(paths)) != len(paths):
        errors.append(f'{label} has duplicate paths')
    for row in rows:
        if row['path'] not in all_files:
            errors.append(f"Unknown baseline path: {row['path']}")
        expected_origins = {origin for origin, files in [('main', main_files), ('local', local_files)] if row['path'] in files}
        if set(row['origins']) != expected_origins:
            errors.append(f"Wrong source origins for {row['path']}")
    listed = set(paths)
    if label == 'components':
        required = {name for name in all_files if name.startswith(('packages/', 'src/', 'scripts/', 'examples/', 'patches/', '.agents/')) and '/lib/' not in name and not name.endswith('.tsbuildinfo')}
    else:
        required = {name for name in all_files if name.startswith('tests/')}
    missing = sorted(required - listed)
    if missing:
        errors.append(f'{label} omits baseline files: {missing}')

patches = components['hostExtensions']
if len(patches) != 19 or len({(row['package'], row['path']) for row in patches}) != 19:
    errors.append('The host extension census must account for all 19 baseline file patches')
for row in patches:
    if row['phase'] not in {'P1', 'P6'} or row['disposition'] not in {'evaluate', 'remove'}:
        errors.append('Invalid host extension disposition or phase')
    if row.get('section') and row['section'] not in headings:
        errors.append(f"Unknown host extension design heading: {row['section']}")

if [row['id'] for row in phases['phases']] != [f'P{i}' for i in range(8)]:
    errors.append('Phase ledger must contain P0 through P7 in order')

restored = None
if args.archive:
    archive_hash = hashlib.sha256(args.archive.read_bytes()).hexdigest()
    if archive_hash != baseline['archive']['sha256']:
        errors.append('Private baseline archive fingerprint does not match')
    else:
        with tempfile.TemporaryDirectory(prefix='flow-baseline-') as directory:
            target = Path(directory)
            with tarfile.open(args.archive) as archive:
                archive.extractall(target, filter='data')
            for name, expected in baseline['files'].items():
                path = target / name
                if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected['sha256']:
                    errors.append(f'Restored baseline file differs: {name}')
            for name in baseline['deleted']:
                if (target / name).exists():
                    errors.append(f'Deleted baseline file reappears: {name}')
            restored = len(baseline['files'])

result = {'contracts': len(contracts['contracts']), 'scenarios': len(scenario_ids), 'components': len(components['components']), 'testsAndFixtures': len(tests['tests']), 'hostFilePatches': len(patches), 'restoredFiles': restored, 'errors': errors}
print(json.dumps(result, ensure_ascii=False, indent=2))
raise SystemExit(bool(errors))
