/** remote-grow.js
 * Usage: run remote-grow.js target startDelayMs
 */
export async function main(ns) {
    const target = ns.args[0];
    const delay = Number(ns.args[1]) || 0;
    if (!target) {
        ns.tprint("remote-grow.js: missing target");
        return;
    }
    if (delay > 0) await ns.sleep(delay);
    await ns.grow(target);
}
