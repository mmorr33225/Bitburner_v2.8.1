// pull.js
// Pulls ALL files to HOME and overwrites existing ones.

export async function main(ns) {
  const apiUrl = "https://api.github.com/repos/mmorr33225/Bitburner_v2.8.1/contents/SRC?ref=main";
  const tmp = "_gh_src_listing.json";

  ns.tprint("Fetching folder listing from GitHub…");
  const okList = await ns.wget(apiUrl, tmp, "home");
  if (!okList) {
    ns.tprint("Failed to fetch GitHub folder listing.");
    ns.tprint(apiUrl);
    return;
  }

  let entries;
  try {
    entries = JSON.parse(ns.read(tmp));
  } catch (e) {
    ns.tprint("Failed to parse GitHub API response (not JSON?).");
    return;
  } finally {
    ns.rm(tmp, "home"); // cleanup
  }

  if (!Array.isArray(entries)) {
    ns.tprint("GitHub API did not return a file list. Is the path public and a folder?");
    return;
  }

  // Filter to only actual files (skip subdirectories if any)
  const files = entries.filter(e => e && e.type === "file" && e.download_url && e.name);

  if (files.length === 0) {
    ns.tprint("No files found in SRC/.");
    return;
  }

  ns.tprint(`Found ${files.length} file(s). Downloading to home (overwrites if exists)…`);
  let okCount = 0, failCount = 0;
  for (const f of files) {
    const ok = await ns.wget(f.download_url, f.name, "home");
    ns.tprint(`${ok ? "OK  " : "FAIL"} ${f.name}`);
    ok ? okCount++ : failCount++;
  }
  ns.tprint(`Done. OK=${okCount}  FAIL=${failCount}`);
}
