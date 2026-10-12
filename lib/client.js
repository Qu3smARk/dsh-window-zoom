/**
 * dsh-window-zoom — browser half.
 *
 * Scales the whole dsh web GUI (sidebar, chat, composer, overlays) by setting
 * the CSS `zoom` property on the document root. That single declaration is
 * enough for this app because the shell lays itself out with an
 * `html, body, #root { height: 100% }` chain: Chromium scales the initial
 * containing block together with the root zoom, so the chain keeps filling the
 * window at every factor (verified against headless Chromium; only raw
 * `vh`/`vw` lengths are not compensated, and the shell uses those for overlay
 * max-heights only).
 *
 * The control counter-scales itself through `--dsh-window-zoom-inverse`, so it
 * keeps a constant physical size and stays reachable at 250%.
 *
 * Scaling alone is not enough. A root `zoom` splits the DOM's coordinate system
 * in two: `getBoundingClientRect`, `getClientRects`, mouse coordinates and
 * `innerWidth`/`innerHeight` report root-frame pixels, while style writes,
 * `offset*`, `scroll*` and computed values stay in the zoomed layout space.
 * Application code was written against the no-zoom invariant that the two
 * agree, so every "measure a rect, write a style" site lands at
 * `rect × factor` — misplaced menus, a shifted tab bar, and the composer's
 * Lexical block cursor (which the editor shows instead of the native caret).
 * The coordinate shim re-establishes the invariant: it reports the root-frame
 * APIs in layout space and accepts layout-space input in the point-query APIs.
 * One consumer must keep the original space: the desktop platform overlay hands
 * its viewport rectangle to the native bridge, which positions a native child
 * view in window DIP, so that subtree is explicitly exempt.
 * It can be switched off from the control to compare against the raw behaviour.
 *
 * Separately, the shell's own Windows caption strip
 * (`--dsh-windows-titlebar-height`) is deliberately left alone: the skin plugin
 * measures the header from rects and mixes that variable into its own layout, so
 * compensating the variable fights the skin. The conflict it exists to avoid —
 * the session header's right-hand controls sliding under the native minimize/
 * close buttons — is instead solved structurally, by moving those clusters to
 * the left edge of the header (see HEADER_LEFT_SELECTOR).
 *
 * Loading contract: a dsh client-module bundle registers one factory here. The
 * module body runs at materialization — before the shell paints — which is
 * where the persisted factor is applied to avoid a flash at 100%.
 */

window.__ModuleLoader__.load({
	id: "dsh-window-zoom",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** Smallest accepted factor. */
		const MIN_FACTOR = 0.5;
		/** Largest accepted factor. */
		const MAX_FACTOR = 2.5;
		/** Button and keyboard step. */
		const STEP = 0.1;
		/** Ctrl+wheel step: finer, because one gesture emits many events. */
		const WHEEL_STEP = 0.05;
		/** localStorage key holding the persisted factor. */
		const FACTOR_KEY = "dsh.windowZoom.factor";
		/** localStorage key holding the persisted dock corner. */
		const DOCK_KEY = "dsh.windowZoom.dock";
		/** Class on the injected control. */
		const CONTROL_CLASS = "dsh-window-zoom";
		/** Class on the transient readout. */
		const TOAST_CLASS = "dsh-window-zoom-toast";
		/** Custom property carrying the current factor. */
		const ZOOM_VAR = "--dsh-window-zoom";
		/** Custom property carrying 1 / factor, the control's counter-scale. */
		const INVERSE_VAR = "--dsh-window-zoom-inverse";
		/** Visual gap between the control and its window corner, in on-screen pixels. */
		const CORNER_GAP = 18;
		/** Visual distance of the readout from the top edge, in on-screen pixels. */
		const TOAST_TOP = 20;
		/** localStorage key holding the coordinate-shim preference. */
		const SHIM_KEY = "dsh.windowZoom.coordinateShim";
		/** localStorage key holding the "header controls on the left" preference. */
		const HEADER_LEFT_KEY = "dsh.windowZoom.headerControlsLeft";
		/** Root attribute that switches the header relocation on. */
		const HEADER_LEFT_ATTR = "data-dsh-window-zoom-header-left";
		/**
		 * Selector for the session header: the only `header` that owns a title row
		 * and the corner/utilities containers. The relocation is scoped to it, so
		 * no other surface is touched.
		 */
		const HEADER_SELECTOR = "header:has(> [class*=titleRow]):has([class*=headerCorner], [class*=headerUtilities])";
		/** Document-relative host route that stores the header diagnostic dump. */
		const DUMP_ROUTE = "api/dsh-window-zoom/header-dump";
		/** How many dumps one page load may send, keeping the diagnostic bounded. */
		const DUMP_MAX_SENDS = 8;
		/** Windows caption strip height in window pixels (the shell's titleBarOverlay). */
		const CAPTION_STRIP_HEIGHT = 40;
		/** Gap kept between the caption buttons and the first pinned cluster. */
		const CAPTION_GAP = 8;
		/** Fallback right offset when the skin has not published its own: 3 × 46px buttons + gap. */
		const CAPTION_FALLBACK_RIGHT = 146;
		/** Dock corners in cycle order; the first is the default. */
		const DOCKS = ["bottom-right", "bottom-left", "top-right", "top-left"];
		/** Corner glyph shown on the grip, matching DOCKS. */
		const DOCK_GLYPHS = {
			"bottom-right": "↘",
			"bottom-left": "↙",
			"top-right": "↗",
			"top-left": "↖"
		};
		/** Transform origin keeping the counter-scaled control inside its corner. */
		const DOCK_ORIGINS = {
			"bottom-right": "100% 100%",
			"bottom-left": "0% 100%",
			"top-right": "100% 0%",
			"top-left": "0% 0%"
		};
		/**
		 * Services required before apply runs. The one service this half uses
		 * (`shortcuts`) is resolved lazily through `ctx.get`, so the plugin still
		 * loads in a composition that omits it.
		 */
		const inject = [];

		/** English copy. */
		const EN = {
			group: "Window zoom",
			out: "Zoom out (Ctrl+Alt+-)",
			reset: "Reset to 100% (Ctrl+Alt+0)",
			in: "Zoom in (Ctrl+Alt+=)",
			dock: "Move the zoom control",
			shim: "Coordinate correction: reports measured positions in the zoomed layout space so menus, the editor caret and tab metrics land correctly. Keep it on; switch it off to compare.",
			shimOn: "Coordinate correction on",
			shimOff: "Coordinate correction off (raw zoom)",
			headerLeft: "Move the session header's right-hand controls (utilities and corner) to the left edge, away from the Windows minimize/close buttons.",
			headerLeftOn: "Header controls moved left",
			headerLeftOff: "Header controls back on the right",
			toast: (percent) => "Window zoom " + percent + "%"
		};

		/** Chinese copy. */
		const ZH = {
			group: "窗口缩放",
			out: "缩小界面 (Ctrl+Alt+-)",
			reset: "重置为 100% (Ctrl+Alt+0)",
			in: "放大界面 (Ctrl+Alt+=)",
			dock: "切换缩放控件停靠角",
			shim: "坐标校正：把测量到的位置折算回缩放后的布局空间，让菜单、输入框光标、页签度量落在正确位置。建议保持开启，可关闭以对比。",
			shimOn: "坐标校正已开启",
			shimOff: "坐标校正已关闭（原始缩放）",
			headerLeft: "把会话顶栏右侧的控件（工具区与角标区）移到最左侧，避开 Windows 的最小化/关闭按钮。",
			headerLeftOn: "顶栏控件已左移",
			headerLeftOff: "顶栏控件已放回右侧",
			toast: (percent) => "窗口缩放 " + percent + "%"
		};

		/** Current factor; the module body loads it from storage. */
		let factor = 1;
		/** Docked corner of the control. */
		let dock = "bottom-right";
		/** The control element while mounted. */
		let control = null;
		/** The percentage button inside the control. */
		let valueButton = null;
		/** The grip button inside the control. */
		let gripButton = null;
		/** The coordinate-shim toggle inside the control. */
		let shimButton = null;
		/** Whether measured coordinates are being converted into layout space. */
		let shimEnabled = true;
		/** Whether the shim's patches are currently installed. */
		let shimInstalled = false;
		/** Undo callbacks recorded by the shim installer, newest last. */
		const shimUndo = [];
		/** The header-relocation toggle inside the control. */
		let headerLeftButton = null;
		/** Dumps sent by this page load. */
		let dumpSends = 0;
		/** Pending debounced dump timer. */
		let dumpTimer = 0;
		/** Watches the UI for the header settling so a fresh dump follows. */
		let dumpObserver = null;
		/** Native point-query method, captured before the shim replaces it. */
		const nativeDocument = { elementsFromPoint: null };
		/** Title-bar clusters this plugin pinned, so they can be released cleanly. */
		const pinnedTitleBar = new Set();
		/** Whether the header's right-hand clusters are moved to the left edge. */
		let headerLeftEnabled = true;
		/** The transient readout while mounted. */
		let toast = null;
		/** Pending readout hide timer. */
		let toastTimer = 0;
		/** The injected stylesheet while mounted. */
		let styleTag = null;
		/** Root inline values before this plugin touched them. */
		const origin = { zoom: "", factor: "", inverse: "" };

		/**
		 * Copy table for the language the app was served in.
		 * @returns the English or Chinese table.
		 */
		function labels() {
			let language = "";
			try {
				language = String(navigator.language || "");
			} catch {
				language = "";
			}
			return language.toLowerCase().indexOf("zh") === 0 ? ZH : EN;
		}

		/**
		 * Read one persisted string.
		 * @param key - storage key.
		 * @returns the stored value, or null when absent or unreadable.
		 */
		function restore(key) {
			try {
				return window.localStorage.getItem(key);
			} catch {
				return null;
			}
		}

		/**
		 * Persist one string, ignoring storage being unavailable (private mode,
		 * quota, a denied origin).
		 * @param key - storage key.
		 * @param value - value to store.
		 */
		function store(key, value) {
			try {
				window.localStorage.setItem(key, value);
			} catch {
				/* persistence is best-effort */
			}
		}

		/**
		 * Clamp a candidate factor into the supported range, snapped to whole
		 * percent so Ctrl+wheel never drifts to 118.99999999%.
		 * @param value - candidate factor.
		 * @returns the factor to apply.
		 */
		function clampFactor(value) {
			if (!Number.isFinite(value)) return 1;
			return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, Math.round(value * 100) / 100));
		}

		/**
		 * The persisted factor.
		 * @returns the factor to start with, 1 when nothing valid is stored.
		 */
		function storedFactor() {
			const raw = restore(FACTOR_KEY);
			if (raw === null) return 1;
			const value = Number(raw);
			return Number.isFinite(value) ? clampFactor(value) : 1;
		}

		/**
		 * The persisted dock corner.
		 * @returns a member of DOCKS.
		 */
		function storedDock() {
			const raw = restore(DOCK_KEY);
			return raw !== null && DOCKS.indexOf(raw) !== -1 ? raw : DOCKS[0];
		}

		/**
		 * The persisted coordinate-shim preference.
		 * @returns true when the shim should be installed (the default).
		 */
		function storedShim() {
			return restore(SHIM_KEY) !== "0";
		}

		/**
		 * The persisted header-relocation preference.
		 * @returns true when the header's right-hand clusters move left (the default).
		 */
		function storedHeaderLeft() {
			return restore(HEADER_LEFT_KEY) !== "0";
		}

		/**
		 * Turn the header relocation on or off.
		 * @param enabled - whether the session header's right-hand clusters move left.
		 * @param announce - whether to flash the state readout.
		 */
		function setHeaderLeft(enabled, announce) {
			headerLeftEnabled = enabled === true;
			store(HEADER_LEFT_KEY, headerLeftEnabled ? "1" : "0");
			if (typeof document !== "undefined" && document.documentElement !== null) {
				if (headerLeftEnabled) document.documentElement.setAttribute(HEADER_LEFT_ATTR, "");
				else document.documentElement.removeAttribute(HEADER_LEFT_ATTR);
			}
			if (headerLeftButton !== null) {
				headerLeftButton.setAttribute("data-active", headerLeftEnabled ? "true" : "false");
				headerLeftButton.setAttribute("aria-pressed", headerLeftEnabled ? "true" : "false");
			}
			placeTitleBarClusters();
			if (announce === true) showToast(headerLeftEnabled ? labels().headerLeftOn : labels().headerLeftOff);
		}

		/** Release every title-bar cluster this plugin pinned, restoring the skin's own layout. */
		function releaseTitleBarClusters() {
			for (const element of pinnedTitleBar) {
				for (const property of ["position", "top", "right", "left", "transform"]) element.style.removeProperty(property);
			}
			pinnedTitleBar.clear();
		}

		/**
		 * Keep the skin's title-bar clusters beside the caption buttons instead of
		 * under them.
		 *
		 * The skin moves the session header's utilities and corner clusters into
		 * the title bar as fixed elements and computes their offset in *window*
		 * pixels (`--dsh-header-band-right`, e.g. 146 = three 46px caption buttons
		 * plus a gap) — but the value is then used as a layout-pixel `right`, so a
		 * zoom factor above 1 grows the icons while the reservation stays, sliding
		 * them onto the minimize/maximize/close buttons. Re-publishing the same
		 * offsets divided by the factor keeps the clusters at a constant on-screen
		 * distance to the left of the buttons, in the same title-bar band.
		 */
		function placeTitleBarClusters() {
			if (typeof document === "undefined" || document.documentElement === null) return;
			const corner = headerLeftEnabled ? document.querySelector("[data-dsh-header-corner]") : null;
			const actions = headerLeftEnabled ? document.querySelector("[data-dsh-header-actions]") : null;
			if (corner === null) {
				// Not the skin's title-bar layout (or the feature is off): nothing to pin.
				if (pinnedTitleBar.size > 0) releaseTitleBarClusters();
				return;
			}
			const published = Number.parseFloat(corner.style.getPropertyValue("--dsh-header-band-right"));
			let rightVisual = Number.isFinite(published) && published > 0 ? published : CAPTION_FALLBACK_RIGHT;
			const active = new Set();
			for (const [element, gap] of [[corner, 0], [actions, CAPTION_GAP]]) {
				if (element === null || element === undefined) continue;
				active.add(element);
				if (gap > 0) rightVisual += gap;
				element.style.setProperty("position", "fixed", "important");
				element.style.setProperty("top", CAPTION_STRIP_HEIGHT / 2 / factor + "px", "important");
				element.style.setProperty("right", rightVisual / factor + "px", "important");
				element.style.setProperty("left", "auto", "important");
				element.style.setProperty("transform", "translateY(-50%)", "important");
				rightVisual += element.offsetWidth * factor;
			}
			for (const element of [...pinnedTitleBar]) {
				if (active.has(element)) continue;
				pinnedTitleBar.delete(element);
				for (const property of ["position", "top", "right", "left", "transform"]) element.style.removeProperty(property);
			}
			for (const element of active) pinnedTitleBar.add(element);
		}

		/**
		 * A box in window pixels, whatever the shim is reporting.
		 * @param element - element to measure.
		 * @returns [left, top, width, height] in window pixels.
		 */
		function visualBox(element) {
			const rect = element.getBoundingClientRect();
			const scale = shimEnabled && factor !== 1 ? factor : 1;
			return [
				Math.round(rect.left * scale),
				Math.round(rect.top * scale),
				Math.round(rect.width * scale),
				Math.round(rect.height * scale)
			];
		}

		/**
		 * Describe one element for the diagnostic dump.
		 * @param element - element to describe.
		 * @param depth - remaining child recursion depth.
		 * @returns the description.
		 */
		function describeElement(element, depth) {
			const style = getComputedStyle(element);
			const entry = {
				tag: element.tagName.toLowerCase(),
				cls: typeof element.className === "string" ? element.className : "",
				box: visualBox(element),
				position: style.position,
				z: style.zIndex,
				text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30)
			};
			if (depth > 0 && element.children.length > 0) {
				entry.children = [...element.children].slice(0, 14).map((child) => describeElement(child, depth - 1));
			}
			return entry;
		}

		/**
		 * Extra chrome facts a header collision needs: every element an installed
		 * skin marked for its title-bar band, every `<header>` in the document,
		 * and what actually sits inside the Windows caption band.
		 * @returns a JSON-serializable structure.
		 */
		function collectChromeFacts() {
			/** Attribute selectors skins use to flag their title-bar occupants. */
			const bandAttributes = [
				"data-dsh-header-band",
				"data-dsh-header-title",
				"data-dsh-header-actions",
				"data-dsh-header-corner",
				"data-dsh-header-row",
				"data-dsh-header-band-tabs"
			];
			const band = [];
			for (const attribute of bandAttributes) {
				for (const element of document.querySelectorAll("[" + attribute + "]")) {
					const entry = describeElement(element, 0);
					entry.attribute = attribute;
					entry.value = element.getAttribute(attribute);
					band.push(entry);
				}
			}
			const headers = [...document.querySelectorAll("header")].slice(0, 6).map((element) => {
				const entry = describeElement(element, 0);
				entry.childrenClasses = [...element.children].slice(0, 12).map((child) => {
					const name = typeof child.className === "string" ? child.className : "";
					return child.hasAttribute("data-dsh-header-title") ? name + " [title]" : name;
				});
				return entry;
			});
			// Probe the caption band itself: the top-right corner where the native
			// minimize/maximize/close buttons live, in window pixels.
			const factorNow = shimEnabled && factor !== 1 ? factor : 1;
			const visualWidth = window.innerWidth * factorNow;
			const probes = [];
			for (const offset of [40, 90, 140, 200, 300]) {
				const x = Math.round(visualWidth - offset);
				const y = 20;
				let stack = [];
				try {
					const native = nativeDocument.elementsFromPoint;
					const elements = native !== null ? native.call(document, x, y) : [];
					stack = [...elements].slice(0, 5).map((element) => describeElement(element, 0));
				} catch {
					stack = [];
				}
				probes.push({ at: [x, y], stack: stack });
			}
			return { band: band, headers: headers, captionProbes: probes };
		}

		/**
		 * Collect the layout facts needed to fix a window-chrome collision
		 * without DevTools: the session header's subtree, plus every positioned
		 * element sitting near the window's top edge.
		 * @param reason - why this dump was taken.
		 * @returns a JSON-serializable dump.
		 */
		function collectHeaderDump(reason) {
			const root = document.documentElement;
			let header = null;
			try {
				header = document.querySelector(HEADER_SELECTOR);
			} catch {
				header = null;
			}
			const topStrip = [];
			for (const element of document.body.querySelectorAll("*")) {
				const style = getComputedStyle(element);
				if (style.position !== "fixed" && style.position !== "absolute") continue;
				const box = visualBox(element);
				if (box[1] > 96 || box[2] < 6 || box[3] < 6) continue;
				topStrip.push(describeElement(element, 0));
				if (topStrip.length >= 30) break;
			}
			return {
				reason: reason,
				at: new Date().toISOString(),
				factor: factor,
				shim: shimEnabled,
				headerLeft: headerLeftEnabled,
				innerWidth: window.innerWidth,
				innerHeight: window.innerHeight,
				devicePixelRatio: window.devicePixelRatio,
				windowsTitlebar: root.hasAttribute("data-windows-titlebar"),
				captionStrip: getComputedStyle(root).getPropertyValue("--dsh-windows-titlebar-height").trim(),
				rootMarkers: [...root.attributes].map((attribute) => attribute.name).filter((name) => name.startsWith("data-")),
				bodyMarkers: [...document.body.attributes].map((attribute) => attribute.name).filter((name) => name.startsWith("data-")),
				headerMatched: header !== null,
				header: header === null ? null : describeElement(header, 3),
				topStrip: topStrip,
				chrome: collectChromeFacts()
			};
		}

		/**
		 * Send one dump to the host half, which stores it next to the DSH home.
		 * Best-effort: an unreachable route, a blocked fetch or a serialization
		 * failure must never disturb the UI.
		 * @param reason - why this dump is being sent.
		 */
		function sendHeaderDump(reason) {
			if (dumpSends >= DUMP_MAX_SENDS) return;
			dumpSends += 1;
			let body;
			try {
				body = JSON.stringify(collectHeaderDump(reason));
			} catch {
				return;
			}
			try {
				window.fetch(DUMP_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: body
				}).catch(() => {});
			} catch {
				/* fetch unavailable: the dump is best-effort */
			}
		}

		/** Re-dump once the UI settles, bounded by DUMP_MAX_SENDS. */
		function watchHeaderForDump() {
			if (typeof MutationObserver !== "function") return;
			dumpObserver = new MutationObserver(() => {
				if (dumpTimer !== 0) window.clearTimeout(dumpTimer);
				dumpTimer = window.setTimeout(() => {
					dumpTimer = 0;
					sendHeaderDump("after mutation");
				}, 1500);
			});
			dumpObserver.observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["class", "style"]
			});
		}

		/**
		 * Find the object owning a property and its descriptor, walking the
		 * prototype chain.
		 * @param start - object to start the search from.
		 * @param name - property name.
		 * @returns the owner and descriptor, or null when the property is absent.
		 */
		function findAccessor(start, name) {
			let owner = start;
			while (owner !== null && owner !== undefined) {
				const descriptor = Object.getOwnPropertyDescriptor(owner, name);
				if (descriptor !== undefined) return { owner: owner, descriptor: descriptor };
				owner = Object.getPrototypeOf(owner);
			}
			return null;
		}

		/**
		 * Selector for the desktop platform overlay: the full-window dialog whose
		 * viewport rectangle is handed to the native bridge as window DIP
		 * (`dshPlatform.open(page, bounds)` / `setBounds(bounds)`), and therefore
		 * must keep root-frame coordinates — the main process positions a native
		 * child view with them, outside the zoomed layout space. Across the
		 * shipped client the only dialog carrying a `header[data-window-drag]` is
		 * this one (every other drag band is a `div`, and the conversation header
		 * is not inside a dialog).
		 */
		const NATIVE_VIEW_SELECTOR = "[role=dialog][aria-modal=true]:has(header[data-window-drag])";

		/**
		 * Whether an element's geometry is consumed outside the document. Only the
		 * platform overlay qualifies: its rect becomes a native view's bounds.
		 * @param element - the element being measured.
		 * @returns true when the element must keep root-frame coordinates.
		 */
		function isNativeViewElement(element) {
			if (element === null || element === undefined || typeof element.closest !== "function") return false;
			try {
				return element.closest(NATIVE_VIEW_SELECTOR) !== null;
			} catch {
				return false;
			}
		}

		/**
		 * Convert one root-frame rect into the zoomed layout space that style
		 * writes, `offset*` and computed values use.
		 * @param rect - rect in root-frame space.
		 * @returns the equivalent rect in layout space.
		 */
		function toLayoutRect(rect) {
			const k = 1 / factor;
			return new DOMRect(rect.x * k, rect.y * k, rect.width * k, rect.height * k);
		}

		/**
		 * Convert a rect list, keeping the list interface callers rely on.
		 * @param list - DOMRectList in root-frame space.
		 * @returns an array of layout-space rects carrying `item()`.
		 */
		function toLayoutRects(list) {
			const rects = [];
			for (let index = 0; index < list.length; index += 1) rects.push(toLayoutRect(list[index]));
			Object.defineProperty(rects, "item", {
				value: (index) => (rects[index] === undefined ? null : rects[index])
			});
			return rects;
		}

		/**
		 * Install the coordinate shim: report the root-frame measurement APIs in
		 * the zoomed layout space, and accept layout-space points in the
		 * point-query APIs. At 100% every patch calls straight through, so the
		 * page behaves exactly as without the plugin.
		 */
		function installShim() {
			if (shimInstalled || typeof document === "undefined") return;
			shimInstalled = true;

			const patchRect = (proto) => {
				const original = proto.getBoundingClientRect;
				shimUndo.push(() => {
					proto.getBoundingClientRect = original;
				});
				proto.getBoundingClientRect = function () {
					const rect = original.call(this);
					if (factor === 1 || isNativeViewElement(this)) return rect;
					return toLayoutRect(rect);
				};
			};
			const patchRects = (proto) => {
				const original = proto.getClientRects;
				shimUndo.push(() => {
					proto.getClientRects = original;
				});
				proto.getClientRects = function () {
					const list = original.call(this);
					if (factor === 1 || isNativeViewElement(this)) return list;
					return toLayoutRects(list);
				};
			};
			patchRect(Element.prototype);
			patchRects(Element.prototype);
			patchRect(Range.prototype);
			patchRects(Range.prototype);

			// Mouse coordinates are root-frame as well, so they are converted with
			// the rects: comparisons between the two stay self-consistent.
			for (const name of ["clientX", "clientY", "x", "y", "offsetX", "offsetY", "pageX", "pageY"]) {
				const found = findAccessor(MouseEvent.prototype, name);
				if (found === null || found.descriptor.get === undefined) continue;
				const read = found.descriptor.get;
				shimUndo.push(() => Object.defineProperty(found.owner, name, found.descriptor));
				Object.defineProperty(found.owner, name, {
					configurable: true,
					get() {
						const value = read.call(this);
						return factor === 1 ? value : value / factor;
					}
				});
			}

			// The viewport size the page sees must match the space its own styles
			// are written in, or clamping against innerWidth drifts.
			for (const name of ["innerWidth", "innerHeight"]) {
				const found = findAccessor(window, name);
				if (found === null || found.descriptor.get === undefined) continue;
				const read = found.descriptor.get;
				shimUndo.push(() => Object.defineProperty(found.owner, name, found.descriptor));
				Object.defineProperty(found.owner, name, {
					configurable: true,
					get() {
						const value = read.call(window);
						return factor === 1 ? value : Math.round(value / factor);
					}
				});
			}

			// Only the root element reports the viewport in root-frame space;
			// every other element's client box is already layout space.
			for (const name of ["clientWidth", "clientHeight"]) {
				const found = findAccessor(Element.prototype, name);
				if (found === null || found.descriptor.get === undefined) continue;
				const read = found.descriptor.get;
				shimUndo.push(() => Object.defineProperty(found.owner, name, found.descriptor));
				Object.defineProperty(found.owner, name, {
					configurable: true,
					get() {
						const value = read.call(this);
						if (factor === 1 || this !== document.documentElement) return value;
						return Math.round(value / factor);
					}
				});
			}

			// Point queries take root-frame viewport coordinates, so callers
			// holding shimmed values convert back on the way in.
			nativeDocument.elementsFromPoint = Document.prototype.elementsFromPoint;
			for (const name of ["elementFromPoint", "elementsFromPoint", "caretRangeFromPoint", "caretPositionFromPoint"]) {
				const original = Document.prototype[name];
				if (typeof original !== "function") continue;
				shimUndo.push(() => {
					Document.prototype[name] = original;
				});
				Document.prototype[name] = function (x, y) {
					if (factor === 1) return original.call(this, x, y);
					return original.call(this, x * factor, y * factor);
				};
			}
		}

		/** Remove every patch the shim installed, newest first. */
		function uninstallShim() {
			while (shimUndo.length > 0) {
				const undo = shimUndo.pop();
				try {
					undo();
				} catch {
					/* one failed restore must not strand the others */
				}
			}
			shimInstalled = false;
		}

		/**
		 * Turn the coordinate shim on or off.
		 * @param enabled - whether the shim should be active.
		 * @param announce - whether to flash the state readout.
		 */
		function setShim(enabled, announce) {
			shimEnabled = enabled === true;
			store(SHIM_KEY, shimEnabled ? "1" : "0");
			if (shimEnabled) installShim();
			else uninstallShim();
			if (shimButton !== null) {
				shimButton.setAttribute("data-active", shimEnabled ? "true" : "false");
				shimButton.setAttribute("aria-pressed", shimEnabled ? "true" : "false");
			}
			if (announce === true) showToast(shimEnabled ? labels().shimOn : labels().shimOff);
		}

		/** Capture the root inline values this plugin must restore on unload. */
		function captureRootOriginals() {
			if (typeof document === "undefined" || document.documentElement === null) return;
			const style = document.documentElement.style;
			origin.zoom = style.getPropertyValue("zoom");
			origin.factor = style.getPropertyValue(ZOOM_VAR);
			origin.inverse = style.getPropertyValue(INVERSE_VAR);
		}

		/**
		 * Write the current factor to the document root and the control.
		 * @param announce - whether to flash the percentage readout.
		 */
		function paint(announce) {
			if (typeof document !== "undefined" && document.documentElement !== null) {
				const style = document.documentElement.style;
				if (factor === 1) style.removeProperty("zoom");
				else style.setProperty("zoom", String(factor));
				style.setProperty(ZOOM_VAR, String(factor));
				style.setProperty(INVERSE_VAR, String(1 / factor));
			}
			if (valueButton !== null) valueButton.textContent = percent(factor);
			// Offsets live in zoomed layout pixels, so both edges and size are
			// compensated to keep the control a constant on-screen size.
			applyDock();
			placeTitleBarClusters();
			if (toast !== null) toast.style.top = TOAST_TOP / factor + "px";
			if (announce === true) showToast();
		}

		/**
		 * Format a factor as a percentage.
		 * @param value - factor to format.
		 * @returns the label shown on the control.
		 */
		function percent(value) {
			return String(Math.round(value * 100)) + "%";
		}

		/**
		 * Set the factor, persist it and repaint.
		 * @param next - candidate factor.
		 * @param announce - whether to flash the percentage readout.
		 */
		function setFactor(next, announce) {
			const clamped = clampFactor(next);
			if (clamped === factor) {
				if (announce === true) showToast();
				return;
			}
			factor = clamped;
			store(FACTOR_KEY, String(factor));
			paint(announce);
		}

		/**
		 * Step the factor.
		 * @param delta - signed step in factor units.
		 */
		function zoomBy(delta) {
			setFactor(factor + delta, true);
		}

		/** Return to 100%. */
		function resetZoom() {
			setFactor(1, true);
		}

		/**
		 * Flash the readout.
		 * @param message - text to show; the zoom percentage when omitted.
		 */
		function showToast(message) {
			if (toast === null) return;
			toast.textContent = message === undefined ? labels().toast(Math.round(factor * 100)) : message;
			toast.setAttribute("data-visible", "true");
			if (toastTimer !== 0) window.clearTimeout(toastTimer);
			toastTimer = window.setTimeout(() => {
				toastTimer = 0;
				if (toast !== null) toast.setAttribute("data-visible", "false");
			}, 900);
		}

		/** Inject the control stylesheet once. */
		function installStyles() {
			if (styleTag !== null || typeof document === "undefined") return;
			const counterScale = "scale(var(" + INVERSE_VAR + ",1))";
			const style = document.createElement("style");
			style.setAttribute("data-dsh-window-zoom", "style");
			style.textContent = [
				"." + CONTROL_CLASS + "{position:fixed;z-index:2147483000;display:inline-flex;align-items:center;gap:2px;",
				"padding:4px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(24,24,28,.78);",
				"color:#f4f4f6;box-shadow:0 6px 20px rgba(0,0,0,.28);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);",
				"font:500 12px/1 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;font-variant-numeric:tabular-nums;",
				"user-select:none;-webkit-user-select:none;touch-action:none;opacity:.9;transition:opacity .16s ease;",
				"transform:" + counterScale + "}",
				"." + CONTROL_CLASS + ":hover{opacity:1}",
				"." + CONTROL_CLASS + " button{appearance:none;border:0;background:transparent;color:inherit;font:inherit;",
				"min-width:22px;height:22px;padding:0 5px;border-radius:999px;cursor:pointer;display:inline-flex;",
				"align-items:center;justify-content:center}",
				"." + CONTROL_CLASS + " button:hover{background:rgba(127,127,127,.3)}",
				"." + CONTROL_CLASS + " button:focus-visible{outline:2px solid currentColor;outline-offset:1px}",
				"." + CONTROL_CLASS + " [data-dsh-window-zoom=value]{min-width:44px}",
				"." + CONTROL_CLASS + " [data-dsh-window-zoom=grip]{cursor:grab;opacity:.72}",
				"." + CONTROL_CLASS + " [data-dsh-window-zoom=shim]{opacity:.5}",
				"." + CONTROL_CLASS + " [data-dsh-window-zoom=shim][data-active=true]{opacity:1;background:rgba(127,127,127,.34)}",
				"." + CONTROL_CLASS + " [data-dsh-window-zoom=header-left]{opacity:.5}",
				"." + CONTROL_CLASS + " [data-dsh-window-zoom=header-left][data-active=true]{opacity:1;background:rgba(127,127,127,.34)}",
				// Header relocation: the Windows caption buttons own the window's
				// top-right corner, so the session header's right-hand clusters move
				// to the left edge instead — corner first, then the leading slot,
				// then the title row with its utilities pulled ahead of the title.
				// `!important` only because installed skins restyle these same
				// clusters with equal-or-higher specificity.
				"html[" + HEADER_LEFT_ATTR + "] " + HEADER_SELECTOR + "{grid-template-columns:auto auto minmax(0,1fr)!important}",
				"html[" + HEADER_LEFT_ATTR + "] " + HEADER_SELECTOR + ">[class*=headerCorner]{grid-column:1!important;grid-row:1!important;justify-self:start!important;margin:0 12px 0 0!important}",
				"html[" + HEADER_LEFT_ATTR + "] " + HEADER_SELECTOR + ">[class*=headerLeading]{grid-column:2!important;grid-row:1!important;justify-self:start!important}",
				"html[" + HEADER_LEFT_ATTR + "] " + HEADER_SELECTOR + ">[class*=titleRow]{grid-column:3!important}",
				"html[" + HEADER_LEFT_ATTR + "] " + HEADER_SELECTOR + ">[class*=titleRow]>[class*=headerUtilities]{order:-1!important;margin-left:0!important;margin-right:16px!important}",
				"html[" + HEADER_LEFT_ATTR + "] " + HEADER_SELECTOR + ">[class*=titleRow]>[class*=titleCluster]>[class*=headerActions]{order:-1!important;margin-right:16px!important}",
				"html[" + HEADER_LEFT_ATTR + "] " + HEADER_SELECTOR + ">[class*=_tabs]{grid-column:1/-1!important}",
				"." + TOAST_CLASS + "{position:fixed;left:50%;top:20px;z-index:2147483001;padding:6px 12px;border-radius:999px;",
				"background:rgba(24,24,28,.86);color:#f4f4f6;font:500 12px/1.2 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;",
				"font-variant-numeric:tabular-nums;box-shadow:0 6px 20px rgba(0,0,0,.28);pointer-events:none;opacity:0;",
				"transition:opacity .16s ease;transform:translateX(-50%) " + counterScale + ";transform-origin:top center}",
				"." + TOAST_CLASS + "[data-visible=true]{opacity:1}",
				"@media (prefers-color-scheme:light){",
				"." + CONTROL_CLASS + "{border-color:rgba(0,0,0,.12);background:rgba(255,255,255,.86);color:#1b1b1f;",
				"box-shadow:0 6px 20px rgba(0,0,0,.16)}",
				"." + TOAST_CLASS + "{background:rgba(255,255,255,.92);color:#1b1b1f}}"
			].join("");
			styleTag = style;
			document.head.appendChild(style);
		}

		/** Remove the injected stylesheet. */
		function removeStyles() {
			if (styleTag !== null && styleTag.parentNode !== null) styleTag.parentNode.removeChild(styleTag);
			styleTag = null;
		}

		/**
		 * Build one control button.
		 * @param glyph - visible glyph.
		 * @param title - tooltip and accessible name.
		 * @param action - click handler.
		 * @returns the button element.
		 */
		function button(glyph, title, action) {
			const element = document.createElement("button");
			element.type = "button";
			element.setAttribute("data-dsh-window-zoom", "button");
			element.textContent = glyph;
			element.title = title;
			element.setAttribute("aria-label", title);
			element.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				action();
			});
			return element;
		}

		/** Mount the control and the readout into the page. */
		function buildControl() {
			const copy = labels();
			const element = document.createElement("div");
			element.className = CONTROL_CLASS;
			element.setAttribute("role", "group");
			element.setAttribute("aria-label", copy.group);

			gripButton = button(DOCK_GLYPHS[dock] || DOCK_GLYPHS[DOCKS[0]], copy.dock, cycleDock);
			gripButton.setAttribute("data-dsh-window-zoom", "grip");
			shimButton = button("⇔", copy.shim, () => setShim(!shimEnabled, true));
			shimButton.setAttribute("data-dsh-window-zoom", "shim");
			shimButton.setAttribute("data-active", shimEnabled ? "true" : "false");
			shimButton.setAttribute("aria-pressed", shimEnabled ? "true" : "false");
			headerLeftButton = button("⇤", copy.headerLeft, () => setHeaderLeft(!headerLeftEnabled, true));
			headerLeftButton.setAttribute("data-dsh-window-zoom", "header-left");
			headerLeftButton.setAttribute("data-active", headerLeftEnabled ? "true" : "false");
			headerLeftButton.setAttribute("aria-pressed", headerLeftEnabled ? "true" : "false");
			valueButton = button(percent(factor), copy.reset, resetZoom);
			valueButton.setAttribute("data-dsh-window-zoom", "value");

			element.appendChild(gripButton);
			element.appendChild(shimButton);
			element.appendChild(headerLeftButton);
			element.appendChild(button("−", copy.out, () => zoomBy(-STEP)));
			element.appendChild(valueButton);
			element.appendChild(button("+", copy.in, () => zoomBy(STEP)));
			// The control is chrome, not page input: never let a click or a wheel
			// over it reach the shell underneath.
			element.addEventListener("pointerdown", (event) => event.stopPropagation());
			element.addEventListener("wheel", (event) => event.stopPropagation());
			control = element;

			const readout = document.createElement("div");
			readout.className = TOAST_CLASS;
			readout.setAttribute("data-visible", "false");
			toast = readout;

			document.body.appendChild(element);
			document.body.appendChild(readout);
		}

		/** Detach the control and the readout. */
		function removeControl() {
			if (toastTimer !== 0) {
				window.clearTimeout(toastTimer);
				toastTimer = 0;
			}
			if (control !== null && control.parentNode !== null) control.parentNode.removeChild(control);
			if (toast !== null && toast.parentNode !== null) toast.parentNode.removeChild(toast);
			control = null;
			valueButton = null;
			gripButton = null;
			shimButton = null;
			headerLeftButton = null;
			toast = null;
		}

		/** Move the control to the current dock corner. */
		function applyDock() {
			if (control === null) return;
			const gap = CORNER_GAP / factor + "px";
			const right = dock === "bottom-right" || dock === "top-right";
			const bottom = dock === "bottom-right" || dock === "bottom-left";
			control.style.left = right ? "auto" : gap;
			control.style.right = right ? gap : "auto";
			control.style.top = bottom ? "auto" : gap;
			control.style.bottom = bottom ? gap : "auto";
			control.style.transformOrigin = DOCK_ORIGINS[dock];
		}

		/** Rotate the control to the next dock corner. */
		function cycleDock() {
			dock = DOCKS[(DOCKS.indexOf(dock) + 1) % DOCKS.length];
			store(DOCK_KEY, dock);
			applyDock();
			if (gripButton !== null) gripButton.textContent = DOCK_GLYPHS[dock];
		}

		/**
		 * Bind the zoom combos for compositions without the shortcut service.
		 * @returns the disposer removing the listener.
		 */
		function installFallbackKeys() {
			const handler = (event) => {
				if (event.ctrlKey !== true && event.metaKey !== true) return;
				if (event.altKey !== true) return;
				if (event.code === "Equal" || event.code === "NumpadAdd") {
					event.preventDefault();
					zoomBy(STEP);
				} else if (event.code === "Minus" || event.code === "NumpadSubtract") {
					event.preventDefault();
					zoomBy(-STEP);
				} else if (event.code === "Digit0" || event.code === "Numpad0") {
					event.preventDefault();
					resetZoom();
				}
			};
			window.addEventListener("keydown", handler, true);
			return () => window.removeEventListener("keydown", handler, true);
		}

		/**
		 * Zoom with Ctrl+wheel, leaving embedded terminals to their own wheel
		 * handling.
		 * @returns the disposer removing the listener.
		 */
		function installWheel() {
			const handler = (event) => {
				if (event.ctrlKey !== true && event.metaKey !== true) return;
				const target = event.target;
				if (target !== null && typeof target.closest === "function") {
					try {
						if (target.closest(".xterm, [class*=terminal], [data-dsh-terminal]") !== null) return;
					} catch {
						/* a non-element target cannot be a terminal */
					}
				}
				if (event.deltaY === 0) return;
				event.preventDefault();
				setFactor(factor + (event.deltaY > 0 ? -WHEEL_STEP : WHEEL_STEP), true);
			};
			window.addEventListener("wheel", handler, { passive: false });
			return () => window.removeEventListener("wheel", handler);
		}

		/**
		 * Register the three zoom commands on the official shortcut service so
		 * they appear in the shortcut reference and stay rebindable.
		 * @param shortcuts - the client shortcut service.
		 * @returns the command disposers.
		 */
		function registerShortcuts(shortcuts) {
			const copy = labels();
			const binding = (code) => ({ code: code, modifiers: ["primary", "alt"] });
			const defaults = (code) => ({
				"desktop:macos": binding(code),
				"desktop:windows": binding(code),
				"desktop:linux": binding(code),
				"web:macos": binding(code),
				"web:windows": binding(code),
				"web:linux": binding(code)
			});
			const command = (id, label, aliases, code, run) => ({
				id: id,
				label: () => label,
				aliases: aliases,
				defaults: defaults(code),
				regions: ["page", "editable", "terminal"],
				modals: [],
				resolve: () => ({ status: "handled", run: run })
			});
			return [
				shortcuts.register(command("window-zoom.in", copy.in, ["zoom in", "放大界面"], "Equal", () => zoomBy(STEP))),
				shortcuts.register(command("window-zoom.out", copy.out, ["zoom out", "缩小界面"], "Minus", () => zoomBy(-STEP))),
				shortcuts.register(command("window-zoom.reset", copy.reset, ["zoom reset", "重置缩放"], "Digit0", () => resetZoom()))
			];
		}

		/** Restore the root inline values the page had before this plugin ran. */
		function releaseRoot() {
			if (typeof document === "undefined" || document.documentElement === null) return;
			const style = document.documentElement.style;
			if (origin.zoom === "") style.removeProperty("zoom");
			else style.setProperty("zoom", origin.zoom);
			if (origin.factor === "") style.removeProperty(ZOOM_VAR);
			else style.setProperty(ZOOM_VAR, origin.factor);
			if (origin.inverse === "") style.removeProperty(INVERSE_VAR);
			else style.setProperty(INVERSE_VAR, origin.inverse);
		}

		/**
		 * Browser-half body: apply the persisted factor and mount the control,
		 * its shortcuts and its wheel binding.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => () => releaseRoot(), "dsh-window-zoom: root zoom");

			// Installed first so it is torn down last: the control unmounts while
			// the shim is still active, and the page is left unpatched afterwards.
			ctx.effect(() => {
				if (shimEnabled) installShim();
				return () => uninstallShim();
			}, "dsh-window-zoom: coordinate shim");

			// The relocation is a root attribute, so the stylesheet stays inert
			// until it is switched on and the header keeps its stock layout otherwise.
			ctx.effect(() => {
				setHeaderLeft(headerLeftEnabled, false);
				return () => {
					if (typeof document !== "undefined" && document.documentElement !== null) {
						document.documentElement.removeAttribute(HEADER_LEFT_ATTR);
					}
				};
			}, "dsh-window-zoom: header clusters");

			// The skin re-syncs its title-bar band on its own schedule (it measures
			// rects and rebuilds the offsets), so the pinned placement is re-applied
			// on zoom, on resize, and after any settle of the UI.
			ctx.effect(() => {
				const place = () => placeTitleBarClusters();
				const timers = [
					window.setTimeout(place, 800),
					window.setTimeout(place, 2500),
					window.setTimeout(place, 6000)
				];
				window.addEventListener("resize", place);
				let settle = 0;
				const observer = typeof MutationObserver === "function"
					? new MutationObserver(() => {
						if (settle !== 0) window.clearTimeout(settle);
						settle = window.setTimeout(() => {
							settle = 0;
							place();
						}, 400);
					})
					: null;
				if (observer !== null) {
					observer.observe(document.body, {
						childList: true,
						subtree: true,
						attributes: true,
						attributeFilter: ["class", "style", "data-dsh-header-band", "data-dsh-header-actions", "data-dsh-header-corner"]
					});
				}
				place();
				return () => {
					for (const timer of timers) window.clearTimeout(timer);
					if (settle !== 0) window.clearTimeout(settle);
					window.removeEventListener("resize", place);
					if (observer !== null) observer.disconnect();
					releaseTitleBarClusters();
				};
			}, "dsh-window-zoom: title bar clusters");

			// Diagnostic: the header's live shape depends on the installed skin, so
			// a bounded dump is written next to the DSH home where it can be read
			// without opening DevTools.
			ctx.effect(() => {
				const early = window.setTimeout(() => sendHeaderDump("on apply"), 2000);
				const settled = window.setTimeout(() => sendHeaderDump("settled"), 6000);
				watchHeaderForDump();
				return () => {
					window.clearTimeout(early);
					window.clearTimeout(settled);
					if (dumpTimer !== 0) {
						window.clearTimeout(dumpTimer);
						dumpTimer = 0;
					}
					if (dumpObserver !== null) {
						dumpObserver.disconnect();
						dumpObserver = null;
					}
				};
			}, "dsh-window-zoom: header dump");

			ctx.effect(() => {
				installStyles();
				buildControl();
				applyDock();
				paint(false);
				const releaseWheel = installWheel();
				return () => {
					releaseWheel();
					removeControl();
					removeStyles();
				};
			}, "dsh-window-zoom: control");

			ctx.effect(() => {
				const shortcuts = typeof ctx.get === "function" ? ctx.get("shortcuts") : undefined;
				if (shortcuts !== undefined && shortcuts !== null) {
					try {
						const disposers = registerShortcuts(shortcuts);
						return () => {
							for (const dispose of disposers) dispose();
						};
					} catch {
						// This build rejected the ids or the default combinations;
						// the DOM binding below keeps the feature usable.
					}
				}
				return installFallbackKeys();
			}, "dsh-window-zoom: shortcuts");
		}

		// Materialization precedes the shell's first paint, so a persisted factor
		// lands before anything is visible; apply() only mounts the control.
		captureRootOriginals();
		factor = storedFactor();
		dock = storedDock();
		shimEnabled = storedShim();
		headerLeftEnabled = storedHeaderLeft();
		paint(false);

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
