export async function main(ns) {
  ns.disableLog("sleep");
  const args = ns.args;
  const verbose = (args.length > 0 && String(args[0]).toLowerCase() === "verbose");

  // get purchased servers and optionally include home
  const purchased = ns.getPurchasedServers();
  const hosts = ["home", ...purchased];

  // format helper
  const gb = (n) => Number(n).toFixed(2) + " GB";
  const pad = (s, n=18) => String(s).padEnd(n, ' ');

  let totalUsed = 0;
  let totalMax = 0;

  ns.tprint(`Purchased servers (${purchased.length}) + home:`);
  ns.tprint(pad("HOST") + pad("USED") + pad("MAX") + "PCT");

  for (const h of hosts) {
    try {
      const used = ns.getServerUsedRam(h);
      const max = ns.getServerMaxRam(h);
      const pct = (max > 0) ? (used / max * 100) : 0;
      totalUsed += used;
      totalMax += max;

      ns.tprint(pad(h) + pad(gb(used)) + pad(gb(max)) + pct.toFixed(1) + "%");

      if (verbose) {
        const procs = ns.ps(h);
        if (procs.length === 0) {
          ns.tprint("  (no running scripts)");
        } else {
          for (const p of procs) {
            const argsText = (p.args && p.args.length) ? p.args.join(" ") : "";
            ns.tprint(`  PID ${p.pid}  ${p.filename}  t=${p.threads}  args=[${argsText}]  RAM/script=${ns.getScriptRam(p.filename, h).toFixed(2)}GB`);
          }
        }
      }
    } catch (e) {
      ns.tprint(`  ${h} : error reading server info (${e})`);
    }
  }

  const clusterPct = (totalMax > 0) ? (totalUsed / totalMax * 100) : 0;
  ns.tprint("");
  ns.tprint(`Cluster total used: ${gb(totalUsed)} / ${gb(totalMax)} (${clusterPct.toFixed(1)}%)`);
}