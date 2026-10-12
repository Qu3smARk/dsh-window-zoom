/**
 * CDP caret-paint probe: does Chromium draw the native text caret at the
 * position its own layout reports when the document root carries CSS `zoom`?
 *
 * Headless Chrome does not paint a caret for an unfocused window, so the driver
 * enables focus emulation first, sets a collapsed selection in a contenteditable
 * line, reads the range rect (the browser's own answer, in root-frame px), and
 * captures a screenshot. The caret is the only red pixel run on the page.
 *
 * Usage: node cdp-caret.mjs <pageUrl> <outPng>
 */
const [url, outPng] = process.argv.slice(2);
const PORT = 9334;

const { spawn } = await import("node:child_process");
const { writeFile } = await import("node:fs/promises");
const chrome = spawn(
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	[
		"--headless=new",
		"--disable-gpu",
		"--no-sandbox",
		"--force-device-scale-factor=1",
		"--window-size=600,300",
		`--remote-debugging-port=${PORT}`,
		`--user-data-dir=${process.env.TEMP}\\dsh-cdp-caret`,
		url
	],
	{ stdio: "ignore" }
);

/**
 * Poll the debugging endpoint until the page target appears.
 * @returns the target's websocket URL.
 */
async function target() {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
			const list = await response.json();
			const page = list.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl !== undefined);
			if (page !== undefined) return page.webSocketDebuggerUrl;
		} catch {
			/* not listening yet */
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("no page target");
}

const socket = new WebSocket(await target());
await new Promise((resolve, reject) => {
	socket.addEventListener("open", resolve, { once: true });
	socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	if (message.id !== undefined && pending.has(message.id)) {
		pending.get(message.id)(message);
		pending.delete(message.id);
	}
});
/**
 * Send one CDP command.
 * @param method - CDP method name.
 * @param params - CDP parameters.
 * @returns the command result.
 */
function send(method, params) {
	const id = nextId++;
	return new Promise((resolve) => {
		pending.set(id, (message) => resolve(message.result));
		socket.send(JSON.stringify({ id, method, params: params ?? {} }));
	});
}

await send("Runtime.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await new Promise((resolve) => setTimeout(resolve, 500));

const probe = await send("Runtime.evaluate", {
	expression: "window.__probe ? window.__probe() : 'no probe'",
	returnByValue: true
});
console.log(probe?.result?.value);

const shot = await send("Page.captureScreenshot", { format: "png" });
await writeFile(outPng, Buffer.from(shot.data, "base64"));
console.log("screenshot: " + outPng);

socket.close();
chrome.kill();
process.exit(0);
