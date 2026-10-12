/**
 * CDP driver for test/caret-click.html.
 *
 * Launches headless Chrome on a private debugging port, dispatches one real
 * mouse click at a given viewport position, then reads window.__probe() back.
 *
 * Usage: node cdp-click.mjs <pageUrl> <x> <y>
 */
const [url, xArg, yArg] = process.argv.slice(2);
const x = Number(xArg);
const y = Number(yArg);
const PORT = 9333;

const { spawn } = await import("node:child_process");
const chrome = spawn(
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	[
		"--headless=new",
		"--disable-gpu",
		"--no-sandbox",
		"--force-device-scale-factor=1",
		"--window-size=600,300",
		`--remote-debugging-port=${PORT}`,
		`--user-data-dir=${process.env.TEMP}\\dsh-cdp-profile`,
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

/** Read a JS expression from the page. */
async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true });
	return result?.result?.value;
}

await send("Runtime.enable");
await new Promise((resolve) => setTimeout(resolve, 700));

await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
await new Promise((resolve) => setTimeout(resolve, 300));

console.log(`click at viewport (${x}, ${y})`);
console.log(await evaluate("window.__probe()"));

socket.close();
chrome.kill();
process.exit(0);
