/** @param {NS} ns **/
export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("getServerMoneyAvailable");
  ns.disableLog("getPurchasedServerCost");

  const LIMIT = ns.getPurchasedServerLimit();        // usually 25
  const MAXRAM = ns.getPurchasedServerMaxRam();      // usually 1,048,576 GB
  const HOME = "home";

  // How much money we have to work with
  const money = ns.getServerMoneyAvailable(HOME);

  // Find the largest power-of-two RAM where we can afford LIMIT servers
  const targetRam = findBestRam(ns, money, LIMIT, MAXRAM);

  if (!targetRam) {
    ns.tprint(`❌ Not enough money to buy ${LIMIT} servers of any size. Need at least ${ns.nFormat(ns.getPurchasedServerCost(2) * LIMIT, "$0.00a")}.`);
    return;
  }

  const perCost = ns.getPurchasedServerCost(targetRam);
  const totalCost = perCost * LIMIT;

  ns.tprint(`✅ Target RAM per server: ${ns.nFormat(targetRam, "0,0")} GB`);
  ns.tprint(`💰 Cost per server: ${ns.nFormat(perCost, "$0.00a")} | Total for ${LIMIT}: ${ns.nFormat(totalCost, "$0.00a")}`);

  // SELL (delete) all existing purchased servers first
  await wipePurchased(ns);

  // Buy LIMIT servers at targetRam
  const base = "pserv-";
  let bought = 0;
  for (let i = 0; i < LIMIT; i++) {
    const name = `${base}${i}`;
    const ok = ns.purchaseServer(name, targetRam);
    if (!ok) {
      ns.tprint(`❌ Failed to purchase ${name} (${ns.nFormat(targetRam, "0,0")} GB). Do you still have enough money?`);
      break;
    }
    bought++;
    ns.print(`Bought ${name} @ ${ns.nFormat(targetRam, "0,0")} GB`);
    // tiny pause just to keep UI responsive
    await ns.sleep(50);
  }

  ns.tprint(`🟩 Purchased ${bought}/${LIMIT} servers @ ${ns.nFormat(targetRam, "0,0")} GB.`);
}

/**
 * Find the largest power-of-two RAM (<= maxRam) where cost * limit <= money.
 * @param {NS} ns
 * @returns {number|0}
 */
function findBestRam(ns, money, limit, maxRam) {
  // Iterate descending powers of two
  for (let ram = maxRam; ram >= 2; ram = ram / 2) {
    if (!Number.isInteger(ram)) continue; // safety (should always be power-of-two)
    const cost = ns.getPurchasedServerCost(ram);
    if (cost * limit <= money) {
      return ram;
    }
  }
  return 0;
}

/**
 * Kill scripts and delete all currently owned purchased servers.
 * @param {NS} ns
 */
async function wipePurchased(ns) {
  const servers = ns.getPurchasedServers();
  if (servers.length === 0) return;

  ns.tprint(`Deleting ${servers.length} existing purchased server(s) to free all ${ns.getPurchasedServerLimit()} slots...`);

  for (const host of servers) {
    try {
      ns.killall(host);
      // give the OS a moment to register processes as stopped
      await ns.sleep(50);
      if (!ns.deleteServer(host)) {
        // If deletion fails, wait a bit and try again
        await ns.sleep(200);
        if (!ns.deleteServer(host)) {
          ns.tprint(`Could not delete ${host}. Make sure no scripts/files lock it.`);
        }
      } else {
        ns.print(`Deleted ${host}`);
      }
    } catch (e) {
      ns.tprint(`Error deleting ${host}: ${String(e)}`);
    }
  }
}
