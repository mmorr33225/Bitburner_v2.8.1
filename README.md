# Bitburner_v2.8.1
Git repo for Bitburner v2.8.1.

---------------------------------------------------------------------------------------------------------------------------------------
MAIN:
---------------------------------------------------------------------------------------------------------------------------------------
pull-js -<br>
Pulls ALL files to HOME and overwrites existing ones. Use this to update files and pull the full project.

auto-batch.js -<br>
-main program called by user that uses remote-hack.js, remote-weaken.js, and remote-grow.js to auto hack the best server available at the time
using distributed batch

---------------------------------------------------------------------------------------------------------------------------------------
TOOLS:
---------------------------------------------------------------------------------------------------------------------------------------
server-status.js -<br>
Lists all purchased servers and their RAM usage as well as the total cluster usage.

scan-info.js -<br>
Lists all servers on hackNet, if they are hackable, money they have left, max money, and root status

root-all.js -<br>
Scans network from 'home' and attempts to gain root on every reachable server then uses whatever port-opening programs exist on home (BruteSSH.exe, FTPCrack.exe, relaySMTP.exe, HTTPWorm.exe, SQLInject.exe). After successful NUKE, it will copy your helper scripts (weaken.js,grow.js,hack.js,auto-batch.js) to the target.

sell-small-servers.js -<br>
Finds all server with least RAM and removes them. Useful for replacing old servers. 

rename-servers.js -<br>
Renames all servers purchased to be consistent with naming scheme "01 Server 8GB". 

kill-all.js -<br>
Kills all active scripts.

---------------------------------------------------------------------------------------------------------------------------------------
HELPERS:
---------------------------------------------------------------------------------------------------------------------------------------
remote-hack.js -<br>
Batch hack() helper called by auto-batch.js to hack remotely. 

remote-weaken.js -<br>
Batch weaken() helper called by auto-batch.js to weaken remotely. 

remote-grow.js -<br>
Batch grow() helper called by auto-batch.js to grow remotely. 

NOTE: These are called by auto-batch and are not called by user 
---------------------------------------------------------------------------------------------------------------------------------------
