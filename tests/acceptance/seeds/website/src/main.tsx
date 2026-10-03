import { createRoot } from 'react-dom/client';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('event-registration seed: index.html has no #root element');
}
createRoot(container).render(null);