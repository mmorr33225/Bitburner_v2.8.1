/** root-all.js
 * Usage:
 *   run root-all.js
 *
 * Scans network from 'home' and attempts to gain root on every reachable server
 * uses whatever port-opening programs exist on home (BruteSSH.exe, FTPCrack.exe, relaySMTP.exe, HTTPWorm.exe, SQLInject.exe).
 * After successful NUKE, it will copy your helper scripts (weaken.js,grow.js,hack.js,auto-batch.js) to the target.
 */

export async function main(ns) {
  ns.disableLog("sleep");
  const meLevel = ns.getHackingLevel();

  // helper to scan all hosts BFS
  function scanAll(start = "home") {
    const q = [start];
    const seen = new Set([start]);
    const out = [];
    while (q.length) {
      const s = q.shift();
      out.push(s);
      for (const c of ns.scan(s)) {
        if (!seen.has(c)) {
          seen.add(c);
          q.push(c);
        }
      }
    }
    return out;
  }

  // which port-openers do we have (on home)?
  const haveBrute = ns.fileExists("BruteSSH.exe", "home");
  const haveFtp   = ns.fileExists("FTPCrack.exe", "home");
  const haveRelay = ns.fileExists("relaySMTP.exe", "home");
  const haveHttp  = ns.fileExists("HTTPWorm.exe", "home");
  const haveSql   = ns.fileExists("SQLInject.exe", "home");

  const portOpeners = [
    {name:"BruteSSH", have:haveBrute, fn: (host)=>ns.brutessh(host)},
    {name:"FTPCrack", have:haveFtp, fn: (host)=>ns.ftpcrack(host)},
    {name:"relaySMTP", have:haveRelay, fn: (host)=>ns.relaysmtp(host)},
    {name:"HTTPWorm", have:haveHttp, fn: (host)=>ns.httpworm(host)},
    {name:"SQLInject", have:haveSql, fn: (host)=>ns.sqlinject(host)}
  ];

  const scriptsToCopy = ["weaken.js","grow.js","hack.js","auto-batch.js"];

  const hosts = scanAll();
  ns.tprint(`Scanned ${hosts.length} hosts. Attempting to root where possible...`);

  for (const host of hosts) {
    // skip home
    if (host === "home") continue;

    try {
      const req = ns.getServerRequiredHackingLevel(host);
      const maxPorts = ns.getServerNumPortsRequired(host);
      // already have root?
      if (ns.hasRootAccess(host)) {
        ns.print(`${host} already root`);
        continue;
      }
      // hacking level check
      if (meLevel < req) {
        ns.print(`${host} requires level ${req} (you ${meLevel}) — skipping`);
        continue;
      }

      // count available openers
      let avail = 0;
      for (const p of portOpeners) if (p.have) avail++;

      if (avail < maxPorts) {
        ns.print(`${host}: needs ${maxPorts} ports, you have ${avail} — skipping`);
        continue;
      }

      // use port openers (call the functions in same order)
      ns.print(`Attempting ports on ${host} (needs ${maxPorts})...`);
      let used = 0;
      for (const p of portOpeners) {
        if (!p.have) continue;
        try {
          p.fn(host);
          used++;
          ns.print(`  used ${p.name} on ${host}`);
          if (used >= maxPorts) break;
        } catch (err) {
          ns.print(`  ${p.name} failed on ${host}: ${err}`);
        }
      }

      // try nuke
      try {
        ns.nuke(host);
      } catch (err) {
        ns.print(`nuke failed on ${host}: ${err}`);
      }

      // check root
      if (ns.hasRootAccess(host)) {
        ns.tprint(`Rooted ${host}!`);
        // copy helpers if present
        const toCopy = scriptsToCopy.filter(s=>ns.fileExists(s,"home"));
        if (toCopy.length > 0) {
          try {
            await ns.scp(toCopy, host);
            ns.print(`  copied ${toCopy.join(", ")} to ${host}`);
          } catch (e) { ns.print(`  scp error to ${host}: ${e}`); }
        }
        // optionally start an auto-batch worker on the new box (commented out by default)
        // const ram = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
        // if (ram >= ns.getScriptRam("weaken.js","home")*1) {
        //    ns.exec("auto-batch.js","home",1,0.03); // or exec on host: ns.exec("auto-batch.js", host, 1, 0.03)
        // }
      } else {
        ns.print(`Failed to gain root on ${host} after opening ports.`);
      }
    } catch (err) {
      ns.print(`Error handling ${host}: ${err}`);
    }
    await ns.sleep(20);
  }

  ns.tprint("root-all finished.");
}
