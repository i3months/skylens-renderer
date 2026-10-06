// Real-socket load run contract (T16.12). Pure documentation plus the shared constants; each module below is owned by one worker.
// Cloud approximation: the server is the product transport (server/ws createWsServer) with a small bench handler, on loopback.
// Server CPU/RSS come from the real server process (/proc), sampled on the real clock. S5/S8 verdicts stay [local] (T17).
//
//   bench/load/socket/server_main.mjs   child-process entry. Reads SKYLENS_WS_HOST / SKYLENS_WS_PORT (loadConfig), starts createWsServer
//                                       with a handler that, per connection, sends LEVEL_PAYLOADS (see below) as binary messages in level order,
//                                       one message per level, immediately after the upgrade. Prints one line `listening <port>` to stdout when ready,
//                                       exits 0 on SIGTERM. No address or port is written in code.
//   bench/load/socket/server_proc.mjs   startServerProcess({ host: '127.0.0.1', env? }) -> Promise<{ port, pid, stop(): Promise<void> }>
//                                       spawns server_main.mjs with port 0 chosen by the OS (passes the port back via the `listening` line).
//   bench/load/socket/ws_client.mjs     connectWs({ host, port, path?: '/' }) -> Promise<{ onMessage(cb(Uint8Array)), onClose(cb), close(), socket }>
//                                       minimal RFC 6455 client (masked frames) built on server/ws/frame, node:net only.
//   bench/load/socket/clients.mjs       runSocketClients({ host, port, clients, durationS, now?: () => ms }) -> Promise<ClientEvent[]>
//                                       opens `clients` connections at the same time, records connect / bytes / level / first_frame / close as
//                                       contracts/load ClientEvent with tMs = real ms since start (now default performance.now). A level event is
//                                       emitted when a LEVEL_PAYLOADS message arrives (level = its index); first_frame is emitted once per client at
//                                       the arrival of its first level payload; every connection stays open until durationS then closes. Events sorted by tMs, then id.
//   bench/load/socket/proc_stats.mjs    readProcStats(pid) -> { cpuUsage: { user, system } (microseconds), rssBytes }   from /proc/<pid>/stat and statm
//                                       (returns null when the process is gone); createProcSampler({ pid, now }) -> createStatsSampler (clock 'real', source 'server-process').
//   bench/load/socket/run.mjs           runSocketLoad({ clients = 30, durationS = 10, commit? }) -> Promise<{ result, violations, serverSamples, report }>
//                                       starts the server process, samples it once per real second while runSocketClients runs, then builds the result with
//                                       runScenario(scenario, { events, commit }) and the real serverSamples checked with checkServerSamples(samples, { durationS }),
//                                       and loadReport(result, { serverSamples }). CLI: node bench/load/socket/run.mjs [outDir] [durationS].
export const LEVEL_PAYLOAD_BYTES = Object.freeze([2048, 8192, 32768, 131072]); // level 0..3 payload sizes, one binary message each
export const SOCKET_HOST = '127.0.0.1';
