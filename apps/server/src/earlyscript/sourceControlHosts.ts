import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";

/**
 * Without `sourceControlHosts` the server registers no hosting driver (GitHub, GitLab, Forgejo,
 * Bitbucket, Azure DevOps, GitCafe): nothing runs `gh` or `glab`, signs in to a host, looks up a
 * repository or pull request on a host, or fetches host media. Local Git keeps its own driver.
 */
export const sourceControlHostDrivers = <Driver>(
  drivers: ReadonlyArray<Driver>,
): ReadonlyArray<Driver> => (earlyscriptFlags.sourceControlHosts ? drivers : []);
