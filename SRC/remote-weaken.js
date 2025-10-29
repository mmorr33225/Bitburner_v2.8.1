export async function main(ns) {
  ns.disableLog("sleep");
  const target = ns.args[0];
  const delay = Number(ns.args[1] ?? 0);
  if (!target) {
    ns.tprint("remote-weaken.js: missing target arg");
    return;
  }
  if (delay > 0) await ns.sleep(Math.max(0, Math.round(delay)));
  try {
    await ns.weaken(target);
  } catch (e) {
    ns.print(`remote-weaken.js: weaken error for ${target}: ${e}`);
  }
}
