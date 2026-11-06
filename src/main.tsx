import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

// Pick the route before importing AppShell: a detached chat must not initialize
// another workspace, editor, PDF worker, or provider controller.
const View = new URLSearchParams(window.location.search).get('view') === 'chat'
  ? lazy(() => import('./features/ai/DetachedChat'))
  : lazy(() => import('./ui/AppShell'));
const host = document.getElementById('root');
if (!host) throw new Error('TexyPaper root element is missing.');
createRoot(host).render(<Suspense fallback={<div role="status">TexyPaper…</div>}><View /></Suspense>);
