import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class InventoryVerification(unittest.TestCase):
    def verify(self, mutate, filename='contracts.json'):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(ROOT / 'docs/alignment', root / 'docs/alignment')
            (root / 'docs/design').mkdir()
            shutil.copyfile(ROOT / 'docs/design/design.md', root / 'docs/design/design.md')
            (root / 'scripts').mkdir()
            shutil.copyfile(ROOT / 'scripts/verify-alignment.py', root / 'scripts/verify-alignment.py')
            path = root / 'docs/alignment' / filename
            data = json.loads(path.read_text())
            mutate(data)
            path.write_text(json.dumps(data))
            return subprocess.run(['python3', str(root / 'scripts/verify-alignment.py')], capture_output=True, text=True)

    def test_complete_census_passes(self):
        self.assertEqual(self.verify(lambda data: None).returncode, 0)

    def test_empty_contract_census_fails(self):
        result = self.verify(lambda data: data.update(contracts=[]))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Missing design contracts', result.stdout)

    def test_missing_contract_fails(self):
        self.assertNotEqual(self.verify(lambda data: data['contracts'].pop()).returncode, 0)

    def test_missing_scenario_fails(self):
        self.assertNotEqual(self.verify(lambda data: data['contracts'][0]['scenarios'].pop()).returncode, 0)

    def test_empty_expected_result_fails(self):
        self.assertNotEqual(self.verify(lambda data: data['contracts'][0]['scenarios'][0].update(expectation=' ')).returncode, 0)

    def test_phase_cannot_start_before_dependency_merges(self):
        result = self.verify(lambda data: (data['phases'][0].update(status='in-progress'), data['phases'][1].update(status='in-progress')), 'phases.json')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('starts before its dependency is merged', result.stdout)

    def test_merged_phase_requires_review_and_merge_evidence(self):
        result = self.verify(lambda data: data['phases'][0].update(status='merged', pullRequest=None, review=None, mergeCommit=None), 'phases.json')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('without review and merge evidence', result.stdout)

    def test_legal_phase_progression_passes(self):
        def advance(data):
            for row in data['phases']:
                row['status'] = 'pending'
            data['phases'][0].update(status='merged', pullRequest='https://github.com/example/repo/pull/1', review={'verdict': 'PASS'}, mergeCommit='a' * 40)
            data['phases'][1]['status'] = 'in-progress'

        self.assertEqual(self.verify(advance, 'phases.json').returncode, 0)


if __name__ == '__main__':
    unittest.main()
