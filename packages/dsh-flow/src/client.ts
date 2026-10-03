/**
 * dsh-flow client assembly (browser half).
 *
 * This is the package's only browser entry: the DSH client loader evaluates it,
 * mounts the generated Remote contribution, and hands the panel to a child
 * plugin. The split is deliberate: an assembly *provides* the `flow` namespace,
 * and a Cordis fiber cannot satisfy its own `inject`, so the panel must be a
 * child fiber on a context where `remote.flow` is already live.
 *
 * The whole file is Client-safe. It never imports the Host entry (`./index.ts`),
 * a `./core/*` module or any Node builtin; the Host DTOs and the generated
 * namespace arrive as type-only imports that the bundler erases.
 */
import type { Context } from '@deepseek-ai/cordis';
// Type-only: load the declaration merges these plugins register into —
// `ctx.remote` (api-gateway), `ctx.slots` + `main` (renderer/layout),
// `sidebar.panellist` (sidebar), and the `connection/reset` event. All erased at
// runtime; the services themselves arrive through each plugin's `inject`.
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import TYPERT_REMOTE from 'dsh-flow/remote';

import { createPanelOperations } from './client/operations.ts';
import { CSS, ClusterPanel, PANEL_ID, PanelIcon } from './client/panel.tsx';

/** The assembly waits only for the Remote client service it mounts into. */
export const inject = ['remote'];

/**
 * Mount the Remote contribution and hand the panel to its own child fiber.
 * @param ctx - the Client Cordis root.
 */
export function apply(ctx: Context): void {
  // One effect owns the contribution: `$mount` resolves to a disposer, so
  // returning its promise gives the fiber the correct async cleanup shape.
  ctx.effect(() => ctx.remote.$mount(TYPERT_REMOTE), 'dsh-flow: cluster remote contribution');
  ctx.plugin(clusterPanelPlugin);
}

/**
 * The global panel: a child of the assembly, so `remote.flow` is resolvable
 * when this fiber activates and its unload cascades with the panel's slots.
 */
const clusterPanelPlugin = {
  name: 'dsh-flow-panel',
  inject: ['slots', 'remote', 'remote.flow'],
  apply(ctx: Context): void {
    // The panel's stylesheet, injected once for this fiber's lifetime.
    ctx.effect(() => {
      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.append(style);
      return () => style.remove();
    }, 'dsh-flow: panel styles');

    // `connection/reset` is the Remote layer's own generation boundary: when the
    // carrier re-establishes, every read that was in flight belongs to the lost
    // generation. The panel's slot props carry no Context, so this fiber — the
    // one that owns the panel — observes the event and hands the panel a
    // subscription through the registration's inject face. This is the "reset
    // callback" form: a frozen generation number could not follow later resets
    // through a shared inject object.
    const resetListeners = new Set<() => void>();
    ctx.effect(
      () => ctx.on('connection/reset', () => {
        for (const listener of [...resetListeners]) listener();
      }),
      'dsh-flow: connection reset',
    );
    const subscribeReset = (listener: () => void): (() => void) => {
      resetListeners.add(listener);
      return () => { resetListeners.delete(listener); };
    };

    // The panel's operations are built from the live namespace at registration
    // time, so an unmounted or replaced contribution cannot leave a stale client
    // object behind.
    ctx.slots.inject('main', () => [
      ctx.slots.register(
        {
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ flow: createPanelOperations(ctx.remote.flow), subscribeReset }),
        },
        ClusterPanel,
      ),
    ]);

    ctx.slots.inject('sidebar.panellist', () => [
      ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 4, label: () => 'Cluster' },
        PanelIcon,
      ),
    ]);
  },
};