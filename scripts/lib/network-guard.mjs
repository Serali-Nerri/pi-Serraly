import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";

const loopback = (host) => process.env.PI_SERRALY_ALLOW_LOOPBACK === "1" &&
	["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);

function deny(label) {
	const message = `Network access denied: ${label}`;
	if (process.env.PI_SERRALY_NETWORK_LOG) appendFileSync(process.env.PI_SERRALY_NETWORK_LOG, message + "\n");
	throw new Error(message);
}

function allowed(args) {
	const first = args[0];
	if (Array.isArray(first)) return allowed(first);
	if (first && typeof first === "object") {
		if (first.path && !first.hostname && !first.host) return true; // local IPC
		return loopback(first.hostname ?? first.host ?? "localhost");
	}
	if (typeof first === "string" && !/^\d+$/.test(first)) return true; // Unix socket
	return loopback(typeof args[1] === "string" ? args[1] : "localhost");
}

for (const [object, key] of [[net, "connect"], [net, "createConnection"], [net.Socket.prototype, "connect"], [tls, "connect"]]) {
	const original = object[key];
	object[key] = function (...args) { if (!allowed(args)) deny(key); return original.apply(this, args); };
}

function requestAllowed(value) {
	if (typeof value === "string" || value instanceof URL) return loopback(new URL(value).hostname);
	return value?.socketPath || loopback(value?.hostname ?? value?.host ?? "localhost");
}
for (const object of [http, https]) {
	for (const key of ["request", "get"]) {
		const original = object[key];
		object[key] = function (...args) { if (!requestAllowed(args[0])) deny(key); return original.apply(this, args); };
	}
}
const fetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
	if (!requestAllowed(typeof input === "string" || input instanceof URL ? input : input.url)) deny("fetch");
	return fetch(input, init);
};
for (const object of [dns, dns.promises]) {
	for (const key of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveSrv", "reverse"]) {
		const original = object[key];
		if (!original) continue;
		object[key] = function (...args) { if (!loopback(args[0])) deny(`dns.${key}`); return original.apply(this, args); };
	}
}
syncBuiltinESMExports();
