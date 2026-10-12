/**
 * Host half of dsh-window-zoom.
 *
 * Window scaling is entirely a browser concern: the client half sets the CSS
 * `zoom` property on the document root and owns its control, shortcuts and
 * persistence. The Node side mounts no UI — it only exposes one loopback-only
 * diagnostic route.
 *
 * Why a route: the browser half cannot write files, and the header-collision
 * fixes depend on the *live* DOM (the session header's containers are restyled
 * by installed skins). The client therefore posts a description of the header
 * and of every fixed/absolute element near the window's top edge, and this
 * handler writes it to `<DSH_HOME>/window-zoom-header-dump.json` so the layout
 * can be inspected from the filesystem instead of DevTools.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Exact path of the diagnostic route. */
const DUMP_ROUTE = "/api/dsh-window-zoom/header-dump";
/** Largest accepted dump body, guarding the loopback route against abuse. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Whether a request originates from this machine.
 * @param request - the incoming HTTP request.
 * @returns true for a loopback host and same-origin requests only.
 */
function isLoopbackRequest(request) {
	const host = request.headers.host;
	if (typeof host !== "string" || host === "") return false;
	try {
		const hostname = new URL("http://" + host).hostname;
		if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]" && hostname !== "::1") return false;
	} catch {
		return false;
	}
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

/**
 * Read a request body up to the guard limit.
 * @param request - the incoming HTTP request.
 * @returns the body text.
 */
async function readBody(request) {
	let text = "";
	for await (const chunk of request) {
		text += chunk;
		if (text.length > MAX_BODY_BYTES) throw new Error("body too large");
	}
	return text;
}

/**
 * Where the dump is written.
 * @returns the absolute file path.
 */
function dumpPath() {
	const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== ""
		? process.env.DSH_HOME
		: join(homedir(), ".dsh");
	return join(home, "window-zoom-header-dump.json");
}

/**
 * Write one JSON response.
 * @param response - the HTTP response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function writeJson(response, status, payload) {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.end(JSON.stringify(payload));
}

/**
 * Host-half body: mount the diagnostic route once the web server exists.
 * @param ctx - host root context.
 */
export function apply(ctx) {
	ctx.inject(["webServer"], (scope) => {
		scope.effect(() => scope.webServer.register({
			kind: "exact",
			path: DUMP_ROUTE,
			handler: async (request, response) => {
				if (!isLoopbackRequest(request)) {
					writeJson(response, 403, { ok: false, error: "forbidden: loopback-only" });
					return;
				}
				if (request.method !== "POST") {
					writeJson(response, 405, { ok: false, error: "method not allowed" });
					return;
				}
				try {
					const parsed = JSON.parse(await readBody(request));
					const path = dumpPath();
					await mkdir(dirname(path), { recursive: true });
					await writeFile(path, JSON.stringify(parsed, null, 1), "utf8");
					writeJson(response, 200, { ok: true, path: path });
				} catch (error) {
					writeJson(response, 400, {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}
		}), "dsh-window-zoom: header dump route");
	});
}
