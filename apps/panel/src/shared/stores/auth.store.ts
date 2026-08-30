import { create } from 'zustand';

export interface SessionUser {
  id: string;
  email: string;
  isAdmin: boolean;
}

interface AuthState {
  accessToken: string | null;
  user: SessionUser | null;
  setSession: (accessToken: string, user: SessionUser) => void;
  setAccessToken: (accessToken: string) => void;
  clear: () => void;
}

// Access token lives in memory ONLY — never localStorage (architecture
// doc 5.3). The refresh token is an HttpOnly cookie the browser sends
// automatically; this store never sees it.
export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  setSession: (accessToken, user) => set({ accessToken, user }),
  setAccessToken: (accessToken) => set({ accessToken }),
  clear: () => set({ accessToken: null, user: null }),
}));
