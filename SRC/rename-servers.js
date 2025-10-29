/** rename-servers.js
 * Renames ALL purchased servers to: "NN Server XGB"
 *   e.g., "01 Server 8GB", "02 Server 64GB"
 *
 * Usage:
 *   run rename-servers.js
 */

export async function main(ns) {
  if (typeof ns.renamePurchasedServer !== "function") {
    ns.tprint("ERROR: ns.renamePurchasedServer is not available in your version.");
    return;
  }

  let servers = ns.getPurchasedServers();
  if (servers.length === 0) {
    ns.tprint("No purchased servers found.");
    return;
  }

  // Deterministic order (alphabetical) so numbering is stable
  servers.sort((a, b) => a.localeCompare(b));

  // Zero-pad width: at least 2
  const startIndex = 1;
  const padWidth = Math.max(2, String(startIndex + servers.length - 1).length);
  const pad = (n) => String(n).padStart(padWidth, "0");

  // Build final names: "NN Server XGB"
  const finalNames = servers.map((host, i) => {
    const ramGb = Math.round(ns.getServerMaxRam(host));
    return `${pad(startIndex + i)} Server ${ramGb}GB`;
  });

  ns.tprint(`Renaming ${servers.length} servers to "NN Server XGB"...`);

  // Phase 1: rename to unique temporary names to avoid collisions
  const temps = [];
  for (let i = 0; i < servers.length; i++) {
    const oldName = servers[i];
    const tmp = `__tmp__${Date.now()}_${i}`;
    try {
      ns.renamePurchasedServer(oldName, tmp);
      temps.push(tmp);
    } catch (e) {
      ns.tprint(`FAILED temp rename ${oldName} -> ${tmp}: ${e}`);
      ns.tprint("Stopping to avoid partial renames.");
      return;
    }
    await ns.sleep(10);
  }

  // Phase 2: rename temps to final names
  for (let i = 0; i < temps.length; i++) {
    const tmp = temps[i];
    const fin = finalNames[i];
    try {
      ns.renamePurchasedServer(tmp, fin);
      ns.tprint(`Renamed: ${fin}`);
    } catch (e) {
      ns.tprint(`FAILED final rename ${tmp} -> ${fin}: ${e}`);
      ns.tprint("Stopping; you may have some '__tmp__...' servers—run this again to clean up.");
      return;
    }
    await ns.sleep(10);
  }

  ns.tprint("All purchased servers renamed successfully.");
}
