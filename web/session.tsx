import { createContext, useContext } from 'react';
import type { AuthSession, AuthStatus } from '../shared/team-types';
export interface SessionContextValue {
  session: AuthSession;
  status: AuthStatus;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
  endSession: (message?: string) => void;
}
export const SessionContext = createContext<SessionContextValue | null>(null);
export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('Workspace session is not available.');
  return session;
}
export function usePermissions() {
  const auth = useContext(SessionContext);
  return {
    canWrite: !auth || auth.session.principal.role !== 'viewer',
    canAdmin: !auth || auth.session.principal.role === 'admin',
    role: auth?.session.principal.role,
  };
}
