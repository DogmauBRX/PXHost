import { create } from 'zustand';

interface UiState {
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
  toggleSidebar: () => void;
  toggleSidebarCollapsed: () => void;
}

/**
 * Mobile drawer state, deliberately kept OUTSIDE the React tree.
 *
 * `AppShell` is a `children` wrapper applied inside each route branch
 * (`/`, `/admin`, `/servers/$serverId`), not a layout route — so navigating
 * between branches unmounts and remounts the whole shell. Component state
 * here would reset mid-navigation; a store survives the remount.
 */
export const useUiStore = create<UiState>((set, get) => ({
  sidebarOpen: false,
  sidebarCollapsed: false,
  openSidebar: () => set({ sidebarOpen: true }),
  closeSidebar: () => set({ sidebarOpen: false }),
  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
  toggleSidebarCollapsed: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
}));
