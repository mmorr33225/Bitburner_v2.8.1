/** scan-info.js
 * Lists server name, whether it's hackable, and money left to hack (current available).
 *
 * Usage:
 *   run scan-info.js               -> all servers
 *   run scan-info.js <hostname>    -> single server
 */
export async function main(ns) {
  ns.disableLog("scan");

  const targetArg = ns.args[0] ? String(ns.args[0]) : null;

  // --- helpers ---
  function scanAll(start = "home") {
    const seen = new Set();
    const q = [start];
    const out = [];
    while (q.length) {
      const s = q.shift();
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      for (const n of ns.scan(s)) if (!seen.has(n)) q.push(n);
    }
    return out;
  }

  const fmtMoney = (n) => {
    if (!Number.isFinite(n)) return "$0";
    const abs = Math.abs(n);
    if (abs >= 1e12) return `$${(n/1e12).toFixed(3)}t`;
    if (abs >= 1e9)  return `$${(n/1e9 ).toFixed(3)}b`;
    if (abs >= 1e6)  return `$${(n/1e6 ).toFixed(3)}m`;
    if (abs >= 1e3)  return `$${(n/1e3 ).toFixed(3)}k`;
    return `$${Math.floor(n)}`;
  };

  function infoFor(host) {
    const req = ns.getServerRequiredHackingLevel(host);
    const my  = ns.getHackingLevel();
    const max = ns.getServerMaxMoney(host) || 0;
    const cur = ns.getServerMoneyAvailable(host) || 0;
    const rooted = ns.hasRootAccess(host);
    const hackable = rooted && max > 0 && my >= req;
    return { host, hackable, cur, max, req, my, rooted };
  }

  // --- main ---
  let hosts = targetArg ? [targetArg] : scanAll("home");
  
  const pserv = new Set(ns.getPurchasedServers());
  hosts = hosts.filter(h => !pserv.has(h));

  // Sort by max money desc, then name
  const rows = hosts.map(infoFor)
                    .sort((a,b) => (b.max - a.max) || a.host.localeCompare(b.host));

  if (rows.length === 0) {
    ns.tprint("No servers found.");
    return;
  }

  // Header
  ns.tprint(pad("Server", 20) + pad("Hackable", 10) + pad("Money Left", 14) + pad("Max Money", 14) + "Root/Req/You");
  ns.tprint("-".repeat(20+10+14+14+16));

  for (const r of rows) {
    ns.tprint(
      pad(r.host, 20) +
      pad(r.hackable ? "YES" : "NO", 10) +
      pad(fmtMoney(r.cur), 14) +
      pad(fmtMoney(r.max), 14) +
      `${r.rooted ? "root" : "no-root"}/${r.req}/${r.my}`
    );
  }

  // pretty aligner
  function pad(s, w) {
    s = String(s);
    if (s.length >= w) return s;
    return s + " ".repeat(w - s.length);
  }
}
