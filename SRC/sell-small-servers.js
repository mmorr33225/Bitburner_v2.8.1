/** sell-small-servers.js
 * Sells ALL purchased servers that have the LOWEST RAM among your purchased servers,
 * then renames the remaining servers using the scheme: "01 Server 8GB", etc.
 *
 * Ensure you run the server-status.js first to check your server
 * as if you only have 1 size server it will remove them all
 * 
 * Usage:
 *   run sell-small-servers.js
 *
 * Notes:
 * - Ensures scripts are killed before deletion.
 * - Skips servers that fail to delete 
 * - Calls: run("RenameServers.js", 1, "--num-server-ram")
 */

export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getPurchasedServers");

  const servers = ns.getPurchasedServers();
  if (servers.length === 0) {
    ns.tprint("No purchased servers found. Nothing to sell.");
    return;
  }

  // Find the minimum RAM across purchased servers
  let minRam = Infinity;
  for (const s of servers) {
    const r = ns.getServerMaxRam(s);
    if (r < minRam) minRam = r;
  }
  if (!Number.isFinite(minRam)) {
    ns.tprint("Unexpected: could not determine minimum RAM.");
    return;
  }

  const toDelete = servers.filter(s => ns.getServerMaxRam(s) === minRam);
  if (toDelete.length === 0) {
    ns.tprint("No servers matched the minimum RAM filter. Nothing to sell.");
  } else {
    ns.tprint(`Selling ${toDelete.length} server(s) with ${minRam}GB RAM...`);
  }

  // Try to delete each lowest-RAM server
  for (const host of toDelete) {
    try {
      // Kill any scripts just in case
      ns.killall(host);
      await ns.sleep(50);
      const ok = ns.deleteServer(host);
      if (ok) {
        ns.tprint(`Deleted: ${host}`);
      } else {
        ns.tprint(`FAILED to delete: ${host} (it may still be busy or not a purchased server)`);
      }
    } catch (e) {
      ns.tprint(`ERROR deleting ${host}: ${e}`);
    }
    await ns.sleep(20);
  }

  // Rename remaining servers using the requested scheme
  // We use a flag so RenameServers.js stays backward compatible.
  const pid = ns.run("RenameServer.js", 1, "--num-server-ram");
  if (pid === 0) {
    ns.tprint("WARNING: Failed to launch RenameServers.js (is it on home?).");
  }
}