import { RunStore } from '../../../../packages/dsh-flow/src/run/store.js';

const [directory, ...ids] = process.argv.slice(2);
if (!directory) throw new Error('archive directory is required');
const store = new RunStore(directory);
process.stdout.write(JSON.stringify(ids.map(id => store.readArchive(id, 'restarted-process'))));
