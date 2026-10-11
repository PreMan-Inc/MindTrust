export type SdkExperimentLink =
  | { kind: 'none' }
  | { kind: 'invalid'; message: string }
  | { kind: 'experiment'; projectName: string; experimentName: string; path: string };

export const PENDING_SDK_LINK_KEY = 'mindtrust-pending-sdk-link';

export function parseSdkExperimentLink(pathname: string): SdkExperimentLink {
  if (!pathname.startsWith('/app/')) return { kind: 'none' };
  const invalid: SdkExperimentLink = {
    kind: 'invalid',
    message: 'This SDK link is not supported. Open Experiments and select the run you need.',
  };
  const match = /^\/app\/([^/]+)\/p\/([^/]+)\/experiments\/([^/]+)\/?$/.exec(pathname);
  if (!match) return invalid;
  try {
    const [organization, projectName, experimentName] = match.slice(1).map(decodeURIComponent);
    if (
      organization !== 'MindTrust' ||
      !projectName.trim() ||
      !experimentName.trim() ||
      [projectName, experimentName].some((value) => /[\u0000-\u001f\u007f]/.test(value))
    )
      return invalid;
    return { kind: 'experiment', projectName, experimentName, path: pathname };
  } catch {
    return invalid;
  }
}

export function uniqueNamedResource<T extends { name: string }>(
  accessibleResources: T[],
  name: string,
  label: 'project' | 'experiment',
): T {
  const matches = accessibleResources.filter((resource) => resource.name === name);
  if (!matches.length)
    throw new Error(`The linked ${label} was not found or you do not have access to it.`);
  if (matches.length !== 1)
    throw new Error(`More than one ${label} has this name. Select the intended ${label} manually.`);
  return matches[0];
}
