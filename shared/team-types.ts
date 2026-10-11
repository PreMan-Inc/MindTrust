/** Workspace authentication and access-management contract. */
export type WorkspaceRole = 'viewer' | 'editor' | 'admin';
export type PrincipalKind = 'user' | 'api-key' | 'bootstrap' | 'development';
export interface AuthPrincipal {
  id: string;
  kind: PrincipalKind;
  role: WorkspaceRole;
  projectIds: string[] | null;
  name: string;
  email?: string;
  workspaceId: string;
  authMethod?: 'local' | 'oidc' | 'preman';
}
export interface AuthStatus {
  enabled: boolean;
  production: boolean;
  oidc?: { label: string; loginUrl: string };
  preman?: { loginUrl: string };
}
export interface AuthSession {
  principal: AuthPrincipal;
  csrfToken: string | null;
  expiresAt: string | null;
  upstreamIdentity?: {
    issuer: string;
    subject: string;
    tenantKind: 'workbench_workspace';
    tenantId: string;
  };
}
export interface WorkspaceUser {
  id: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  projectIds: string[] | null;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  allowOidc?: boolean;
  oidcLinked?: boolean;
  managedBy?: 'preman';
}
export interface WorkspaceApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  role: WorkspaceRole;
  projectIds: string[] | null;
  expiresAt: string;
  revokedAt: string | null;
}
export interface AuditEvent {
  id: string;
  at: string;
  actorId: string;
  actorKind: PrincipalKind;
  action: string;
  projectId: string | null;
  outcome: string;
  statusCode: number;
}
