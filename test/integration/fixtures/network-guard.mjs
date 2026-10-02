// Runtime only. npm's explicit, locked release installation is outside this
// guard; every Pi/provider/native-worker process inherits this preload.
import { appendFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
function reject() {
	appendFileSync(process.env.SERRALY_REPORT, JSON.stringify({ phase: "network-denied" }) + "\n");
	throw new Error("Integration fixture forbids network/model requests");
}
globalThis.fetch = reject;
net.Socket.prototype.connect = reject;
net.connect = net.createConnection = tls.connect = reject;
http.request = http.get = https.request = https.get = reject;
dns.lookup = dns.resolve = dns.promises.lookup = dns.promises.resolve = reject;
syncBuiltinESMExports();
