import { createRoot } from 'react-dom/client';
import { DashboardClient } from '../dashboard/client.js';
import { DashboardApp } from './DashboardApp.js';

const element = document.getElementById('dsh-flow');
if (!element) throw new Error('Missing dsh-flow mount element');
const client = new DashboardClient({ baseUrl: location.origin, origin: location.origin });
const root = createRoot(element);
root.render(<DashboardApp client={client} scope={{ kind: 'global' }} />);
window.addEventListener('pagehide', () => { root.unmount(); client.dispose(); }, { once: true });
