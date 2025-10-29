export async function main(ns) {
  ns.disableLog("sleep");
  const visited = new Set();
  const queue = ["home"];
  let totalKilled = 0;

  while (queue.length) {
    const server = queue.shift();
    if (visited.has(server)) continue;
    visited.add(server);

    // enqueue neighbors
    try {
      for (const n of ns.scan(server)) if (!visited.has(n)) queue.push(n);
    } catch (e) {
      ns.print(`scan failed for ${server}: ${e}`);
    }

    // try to kill all on this server
    try {
      // prefer killall if available
      try {
        if (typeof ns.killall === "function") {
          ns.killall(server);
          ns.print(`kill-all-simple: killall on ${server}`);
          continue;
        }
      } catch (e) {
        // fall through to per-process kills
      }

      const procs = ns.ps(server);
      for (const p of procs) {
        try {
          // try killing with args first, then without
          if (p.args && p.args.length > 0) {
            ns.kill(p.filename, server, ...p.args);
          } else {
            ns.kill(p.filename, server);
          }
          totalKilled++;
        } catch (e) {
          ns.print(`kill-all-simple: failed to kill ${p.filename} on ${server}: ${e}`);
        }
      }
    } catch (e) {
      ns.print(`kill-all: error on ${server}: ${e}`);
    }
  }

  ns.tprint(`kill-all: finished. Visited ${visited.size} servers. Kill attempts: ${totalKilled}`);
}